import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { dataIso, uuid } from '../../http/campos.js';
import { ErroNegocio } from '../../http/erros.js';

const STATUS = ['PENDENTE', 'EM_CONFERENCIA', 'VALIDADO', 'NAO_APLICAVEL'] as const;

interface Parametro {
  id: string;
  exercicioId: string | null;
  codigo: string;
  valor: unknown;
  vigenciaInicio: string;
  vigenciaFim: string | null;
  fonteNormativaId: string | null;
  statusValidacao: (typeof STATUS)[number];
  validadoPor: string | null;
  validadoEm: string | null;
  observacao: string | null;
  /** Verdadeiro só quando a validação foi registrada. Pendentes não podem ser tratados como regra. */
  utilizavelComoRegra: boolean;
}

const COLUNAS = `id, exercicio_id AS "exercicioId", codigo, valor, vigencia_inicio AS "vigenciaInicio",
  vigencia_fim AS "vigenciaFim", fonte_normativa_id AS "fonteNormativaId", status_validacao AS "statusValidacao",
  validado_por AS "validadoPor", validado_em AS "validadoEm", observacao`;

function mapear(r: Omit<Parametro, 'utilizavelComoRegra'> & { validadoEm: Date | null }): Parametro {
  return {
    ...r,
    validadoEm: r.validadoEm ? r.validadoEm.toISOString() : null,
    utilizavelComoRegra: r.statusValidacao === 'VALIDADO',
  };
}

/**
 * Parâmetros legais versionados. Esta camada apenas REGISTRA parâmetros e seu estado de validação.
 * Nenhuma rota do sistema consulta esses valores para calcular, limitar ou bloquear nada.
 */
export function rotasParametros(app: FastifyInstance, pool: Pool) {
  app.get('/fontes-normativas', async () => {
    const { rows } = await pool.query('SELECT id, tipo, identificacao, referencia FROM fonte_normativa ORDER BY tipo, identificacao');
    return rows;
  });

  app.post('/fontes-normativas', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const d = z
      .object({
        tipo: z.string().trim().min(1).max(80),
        identificacao: z.string().trim().min(1).max(300),
        referencia: z.string().trim().max(1000).nullish(),
      })
      .strict()
      .parse(req.body);
    const f = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query(
        'INSERT INTO fonte_normativa (tipo, identificacao, referencia) VALUES ($1,$2,$3) RETURNING id, tipo, identificacao, referencia',
        [d.tipo, d.identificacao, d.referencia ?? null],
      );
      return r.rows[0];
    });
    return reply.status(201).send(f);
  });

  app.get('/parametros-legais', async (req) => {
    const q = z
      .object({ exercicioId: uuid.optional(), codigo: z.string().optional(), data: dataIso.optional() })
      .parse(req.query);
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM parametro_legal
       WHERE ($1::uuid IS NULL OR exercicio_id = $1)
         AND ($2::text IS NULL OR codigo = $2)
         AND ($3::date IS NULL OR (vigencia_inicio <= $3::date AND (vigencia_fim IS NULL OR vigencia_fim >= $3::date)))
       ORDER BY codigo, vigencia_inicio, id`,
      [q.exercicioId ?? null, q.codigo ?? null, q.data ?? null],
    );
    return rows.map(mapear);
  });

  // Nasce sempre PENDENTE; o valor é imutável (nova versão = novo registro).
  app.post('/parametros-legais', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const d = z
      .object({
        exercicioId: uuid.nullish(),
        codigo: z.string().trim().min(1).max(120),
        valor: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
        vigenciaInicio: dataIso,
        vigenciaFim: dataIso.nullish(),
        fonteNormativaId: uuid.nullish(),
        observacao: z.string().trim().max(2000).nullish(),
      })
      .strict()
      .parse(req.body);
    const p = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO parametro_legal (exercicio_id, codigo, valor, vigencia_inicio, vigencia_fim, fonte_normativa_id, observacao)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7) RETURNING ${COLUNAS}`,
        [
          d.exercicioId ?? null,
          d.codigo,
          JSON.stringify(d.valor),
          d.vigenciaInicio,
          d.vigenciaFim ?? null,
          d.fonteNormativaId ?? null,
          d.observacao ?? null,
        ],
      );
      return r.rows[0];
    });
    return reply.status(201).send(mapear(p));
  });

  // PROVISÓRIO: sem autenticação, quem valida é só o texto de X-Usuario. A validação real
  // exige perfis de acesso (pendência registrada). Registra validador e data.
  app.post('/parametros-legais/:id/validacao', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({ status: z.enum(STATUS), observacao: z.string().trim().max(2000).nullish() })
      .strict()
      .parse(req.body);
    return comTransacao(pool, ctx, async (c) => {
      const atual = await c.query<{ fonte_normativa_id: string | null }>(
        'SELECT fonte_normativa_id FROM parametro_legal WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!atual.rows[0]) throw new ErroNegocio(404, 'nao_encontrado', 'Parâmetro não encontrado');
      if (d.status === 'VALIDADO' && !atual.rows[0].fonte_normativa_id) {
        throw new ErroNegocio(422, 'sem_fonte_normativa', 'Só é possível validar um parâmetro com fonte normativa vinculada');
      }
      const validando = d.status === 'VALIDADO';
      const r = await c.query(
        `UPDATE parametro_legal
         SET status_validacao = $2,
             validado_por = CASE WHEN $3 THEN $4 ELSE NULL END,
             validado_em = CASE WHEN $3 THEN now() ELSE NULL END,
             observacao = coalesce($5, observacao)
         WHERE id = $1 RETURNING ${COLUNAS}`,
        [id, d.status, validando, ctx.usuario, d.observacao ?? null],
      );
      return mapear(r.rows[0]);
    });
  });

  // Encerrar a vigência é a única edição de conteúdo permitida.
  app.post('/parametros-legais/:id/encerrar', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ vigenciaFim: dataIso }).strict().parse(req.body);
    return comTransacao(pool, ctx, async (c) => {
      const r = await c.query(
        `UPDATE parametro_legal SET vigencia_fim = $2 WHERE id = $1 AND vigencia_fim IS NULL RETURNING ${COLUNAS}`,
        [id, d.vigenciaFim],
      );
      if (!r.rows[0]) throw new ErroNegocio(404, 'nao_encontrado', 'Parâmetro não encontrado ou já encerrado');
      return mapear(r.rows[0]);
    });
  });
}
