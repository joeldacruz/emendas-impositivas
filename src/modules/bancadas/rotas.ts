import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { dataIso, uuid } from '../../http/campos.js';
import { ErroNegocio } from '../../http/erros.js';


interface Bancada {
  id: string;
  exercicioId: string;
  nome: string;
}
interface Membro {
  id: string;
  bancadaId: string;
  parlamentarId: string;
  vigenciaInicio: string;
  vigenciaFim: string | null;
}
interface Mandato {
  id: string;
  parlamentarId: string;
  inicio: string;
  fim: string | null;
}

/** Mandatos, bancadas e composição histórica. Não aplica regra jurídica alguma. */
export function rotasBancadas(app: FastifyInstance, pool: Pool) {
  // ---- Mandatos ----
  app.get('/parlamentares/:id/mandatos', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await pool.query<Mandato>(
      'SELECT id, parlamentar_id AS "parlamentarId", inicio, fim FROM mandato WHERE parlamentar_id = $1 ORDER BY inicio',
      [id],
    );
    return rows;
  });

  app.post('/parlamentares/:id/mandatos', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ inicio: dataIso, fim: dataIso.nullish() }).strict().parse(req.body);
    const m = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query<Mandato>(
        'INSERT INTO mandato (parlamentar_id, inicio, fim) VALUES ($1,$2,$3) RETURNING id, parlamentar_id AS "parlamentarId", inicio, fim',
        [id, d.inicio, d.fim ?? null],
      );
      return r.rows[0]!;
    });
    return reply.status(201).send(m);
  });

  // ---- Bancadas ----
  app.get('/bancadas', async (req) => {
    const { exercicioId } = z.object({ exercicioId: uuid.optional() }).parse(req.query);
    const { rows } = await pool.query<Bancada>(
      `SELECT id, exercicio_id AS "exercicioId", nome FROM bancada
       WHERE ($1::uuid IS NULL OR exercicio_id = $1) ORDER BY nome, id`,
      [exercicioId ?? null],
    );
    return rows;
  });

  app.post('/bancadas', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const d = z.object({ exercicioId: uuid, nome: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    const b = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query<Bancada>(
        'INSERT INTO bancada (exercicio_id, nome) VALUES ($1,$2) RETURNING id, exercicio_id AS "exercicioId", nome',
        [d.exercicioId, d.nome],
      );
      return r.rows[0]!;
    });
    return reply.status(201).send(b);
  });

  // ---- Composição histórica ----
  app.get('/bancadas/:id/membros', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await pool.query<Membro>(
      `SELECT id, bancada_id AS "bancadaId", parlamentar_id AS "parlamentarId",
              vigencia_inicio AS "vigenciaInicio", vigencia_fim AS "vigenciaFim"
       FROM bancada_membro WHERE bancada_id = $1 ORDER BY vigencia_inicio, id`,
      [id],
    );
    return rows;
  });

  app.post('/bancadas/:id/membros', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({ parlamentarId: uuid, vigenciaInicio: dataIso, vigenciaFim: dataIso.nullish() })
      .strict()
      .parse(req.body);
    const m = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query<Membro>(
        `INSERT INTO bancada_membro (bancada_id, parlamentar_id, vigencia_inicio, vigencia_fim)
         VALUES ($1,$2,$3,$4)
         RETURNING id, bancada_id AS "bancadaId", parlamentar_id AS "parlamentarId",
                   vigencia_inicio AS "vigenciaInicio", vigencia_fim AS "vigenciaFim"`,
        [id, d.parlamentarId, d.vigenciaInicio, d.vigenciaFim ?? null],
      );
      return r.rows[0]!;
    });
    return reply.status(201).send(m);
  });

  // Única alteração permitida em um vínculo: encerrar a vigência. O histórico não é reescrito.
  app.patch('/bancadas/:id/membros/:membroId', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id, membroId } = z.object({ id: uuid, membroId: uuid }).parse(req.params);
    const d = z.object({ vigenciaFim: dataIso }).strict().parse(req.body);
    return comTransacao(pool, ctx, async (c) => {
      const r = await c.query<Membro>(
        `UPDATE bancada_membro SET vigencia_fim = $3
         WHERE id = $2 AND bancada_id = $1 AND vigencia_fim IS NULL
         RETURNING id, bancada_id AS "bancadaId", parlamentar_id AS "parlamentarId",
                   vigencia_inicio AS "vigenciaInicio", vigencia_fim AS "vigenciaFim"`,
        [id, membroId, d.vigenciaFim],
      );
      if (!r.rows[0]) {
        throw new ErroNegocio(404, 'nao_encontrado', 'Vínculo não encontrado ou já encerrado');
      }
      return r.rows[0];
    });
  });

  // Aceite da Fase 3: composição da bancada em uma data.
  app.get('/bancadas/:id/composicao', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { data } = z.object({ data: dataIso }).parse(req.query);
    const b = await pool.query<Bancada>('SELECT id, exercicio_id AS "exercicioId", nome FROM bancada WHERE id = $1', [id]);
    if (!b.rows[0]) throw new ErroNegocio(404, 'nao_encontrada', 'Bancada não encontrada');
    const { rows } = await pool.query<{ parlamentarId: string; nome: string; vigenciaInicio: string; vigenciaFim: string | null }>(
      `SELECT m.parlamentar_id AS "parlamentarId", p.nome,
              m.vigencia_inicio AS "vigenciaInicio", m.vigencia_fim AS "vigenciaFim"
       FROM bancada_membro m JOIN parlamentar p ON p.id = m.parlamentar_id
       WHERE m.bancada_id = $1 AND m.vigencia_inicio <= $2::date
         AND (m.vigencia_fim IS NULL OR m.vigencia_fim >= $2::date)
       ORDER BY p.nome, p.id`,
      [id, data],
    );
    return { bancada: b.rows[0], data, membros: rows };
  });
}
