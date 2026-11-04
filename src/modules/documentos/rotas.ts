import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { uuid } from '../../http/campos.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { ErroNegocio } from '../../http/erros.js';

const COLUNAS = `id, emenda_id AS "emendaId", parecer_id AS "parecerId", diligencia_id AS "diligenciaId",
  nome_arquivo AS "nomeArquivo", tipo_mime AS "tipoMime", tamanho_bytes AS "tamanhoBytes", sha256, descricao,
  classificacao, classificacao_justificativa AS "classificacaoJustificativa", registrado_por AS "registradoPor"`;

interface LinhaDoc {
  tamanhoBytes: string;
  [k: string]: unknown;
}
const mapear = (l: LinhaDoc) => ({ ...l, tamanhoBytes: Number(l.tamanhoBytes) });

/**
 * Documentos: somente METADADOS (nome, tipo, tamanho, SHA-256). O armazenamento do arquivo não foi
 * decidido (pendência). Todo documento nasce 'interno'; publicar exige justificativa e fica auditado.
 */
export function rotasDocumentos(app: FastifyInstance, pool: Pool) {
  app.get('/emendas/:id/documentos', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await pool.query<LinhaDoc>(`SELECT ${COLUNAS} FROM documento WHERE emenda_id = $1 ORDER BY criado_em, id`, [id]);
    return rows.map(mapear);
  });

  app.post('/emendas/:id/documentos', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({
        nomeArquivo: z.string().trim().min(1).max(255),
        tipoMime: z.string().trim().min(3).max(120),
        tamanhoBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 em hexadecimal minúsculo (64 caracteres)'),
        descricao: z.string().trim().max(2000).nullish(),
        parecerId: uuid.nullish(),
        diligenciaId: uuid.nullish(),
      })
      .strict()
      .refine((v) => !(v.parecerId && v.diligenciaId), { message: 'vincule a um parecer OU a uma diligência', path: ['parecerId'] })
      .parse(req.body);
    const doc = await comTransacao(pool, ctx, async (c) => {
      // parecer/diligência vinculados precisam ser da mesma emenda
      if (d.parecerId) {
        const r = await c.query('SELECT 1 FROM parecer WHERE id = $1 AND emenda_id = $2', [d.parecerId, id]);
        if (!r.rowCount) throw new ErroNegocio(422, 'vinculo_invalido', 'Parecer inexistente nesta emenda');
      }
      if (d.diligenciaId) {
        const r = await c.query('SELECT 1 FROM diligencia WHERE id = $1 AND emenda_id = $2', [d.diligenciaId, id]);
        if (!r.rowCount) throw new ErroNegocio(422, 'vinculo_invalido', 'Diligência inexistente nesta emenda');
      }
      const r = await c.query<LinhaDoc>(
        `INSERT INTO documento (emenda_id, parecer_id, diligencia_id, nome_arquivo, tipo_mime, tamanho_bytes, sha256, descricao, registrado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${COLUNAS}`,
        [id, d.parecerId ?? null, d.diligenciaId ?? null, d.nomeArquivo, d.tipoMime, d.tamanhoBytes, d.sha256, d.descricao ?? null, ctx.usuario],
      );
      return mapear(r.rows[0]!);
    });
    return reply.status(201).send(doc);
  });

  app.post('/documentos/:id/classificacao', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({ classificacao: z.enum(['interno', 'publicavel']), justificativa: z.string().trim().min(3).max(2000) })
      .strict()
      .parse(req.body);
    return comTransacao(pool, ctx, async (c) => {
      const r = await c.query<LinhaDoc>(
        `UPDATE documento SET classificacao = $2, classificacao_justificativa = $3 WHERE id = $1 RETURNING ${COLUNAS}`,
        [id, d.classificacao, d.justificativa],
      );
      if (!r.rows[0]) throw new ErroNegocio(404, 'nao_encontrado', 'Documento não encontrado');
      return mapear(r.rows[0]);
    });
  });
}
