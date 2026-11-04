import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { dataIso, uuid } from '../../http/campos.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { ErroNegocio } from '../../http/erros.js';

/**
 * Tramitação, pareceres e diligências em forma NEUTRA: títulos, responsáveis e prazos são informados
 * por quem opera. O sistema não conhece etapas do rito nem calcula prazos legais (pendente de validação).
 * "Atrasada" é apenas: item aberto cujo prazo informado é anterior à data de referência.
 */
export function rotasTramitacao(app: FastifyInstance, pool: Pool) {
  const consulta = z.object({ referencia: dataIso.optional() });

  // ---- Tramitação ----
  const COL_TRAM = `id, emenda_id AS "emendaId", titulo, responsavel, prazo, observacao, situacao,
    encerrada_em AS "encerradaEm", aberta_por AS "abertaPor",
    (situacao = 'aberta' AND prazo IS NOT NULL AND prazo < $2::date) AS atrasada`;

  app.get('/emendas/:id/tramitacao', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { referencia } = consulta.parse(req.query);
    const { rows } = await pool.query(
      `SELECT ${COL_TRAM} FROM tramitacao WHERE emenda_id = $1 ORDER BY criado_em, id`,
      [id, referencia ?? new Date().toISOString().slice(0, 10)],
    );
    return rows;
  });

  app.post('/emendas/:id/tramitacao', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({
        titulo: z.string().trim().min(1).max(300),
        responsavel: z.string().trim().min(1).max(200),
        prazo: dataIso.nullish(),
        observacao: z.string().trim().max(4000).nullish(),
      })
      .strict()
      .parse(req.body);
    const t = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO tramitacao (emenda_id, titulo, responsavel, prazo, observacao, aberta_por)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, emenda_id AS "emendaId", titulo, responsavel, prazo, observacao, situacao, aberta_por AS "abertaPor"`,
        [id, d.titulo, d.responsavel, d.prazo ?? null, d.observacao ?? null, ctx.usuario],
      );
      return r.rows[0];
    });
    return reply.status(201).send(t);
  });

  for (const [acao, situacao] of [
    ['concluir', 'concluida'],
    ['cancelar', 'cancelada'],
  ] as const) {
    app.post(`/tramitacao/:id/${acao}`, async (req) => {
      const ctx = contextoDeAuditoria(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      return comTransacao(pool, ctx, async (c) => {
        const r = await c.query(
          `UPDATE tramitacao SET situacao = $2, encerrada_em = now() WHERE id = $1
           RETURNING id, emenda_id AS "emendaId", titulo, responsavel, prazo, observacao, situacao, encerrada_em AS "encerradaEm"`,
          [id, situacao],
        );
        if (!r.rows[0]) throw new ErroNegocio(404, 'nao_encontrada', 'Tramitação não encontrada');
        return r.rows[0];
      });
    });
  }

  // ---- Pareceres (registro permanente: nova opinião = novo parecer) ----
  const COL_PAR = 'id, emenda_id AS "emendaId", tipo, texto, autor, criado_em AS "criadoEm"';

  app.get('/emendas/:id/pareceres', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await pool.query(`SELECT ${COL_PAR} FROM parecer WHERE emenda_id = $1 ORDER BY criado_em, id`, [id]);
    return rows;
  });

  app.post('/emendas/:id/pareceres', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({ tipo: z.string().trim().min(1).max(80), texto: z.string().trim().min(1).max(20000) })
      .strict()
      .parse(req.body);
    const p = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query(`INSERT INTO parecer (emenda_id, tipo, texto, autor) VALUES ($1,$2,$3,$4) RETURNING ${COL_PAR}`, [
        id,
        d.tipo,
        d.texto,
        ctx.usuario,
      ]);
      return r.rows[0];
    });
    return reply.status(201).send(p);
  });

  // ---- Diligências ----
  const COL_DIL = `id, emenda_id AS "emendaId", texto, prazo, situacao, resposta,
    encerrada_em AS "encerradaEm", encerrada_por AS "encerradaPor", aberta_por AS "abertaPor",
    (situacao = 'aberta' AND prazo IS NOT NULL AND prazo < $2::date) AS atrasada`;

  app.get('/emendas/:id/diligencias', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { referencia } = consulta.parse(req.query);
    const { rows } = await pool.query(`SELECT ${COL_DIL} FROM diligencia WHERE emenda_id = $1 ORDER BY criado_em, id`, [
      id,
      referencia ?? new Date().toISOString().slice(0, 10),
    ]);
    return rows;
  });

  app.post('/emendas/:id/diligencias', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ texto: z.string().trim().min(1).max(10000), prazo: dataIso.nullish() }).strict().parse(req.body);
    const dil = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO diligencia (emenda_id, texto, prazo, aberta_por) VALUES ($1,$2,$3,$4)
         RETURNING id, emenda_id AS "emendaId", texto, prazo, situacao, resposta, aberta_por AS "abertaPor"`,
        [id, d.texto, d.prazo ?? null, ctx.usuario],
      );
      return r.rows[0];
    });
    return reply.status(201).send(dil);
  });

  for (const [acao, situacao, campo] of [
    ['atender', 'atendida', 'resposta'],
    ['cancelar', 'cancelada', 'motivo'],
  ] as const) {
    app.post(`/diligencias/:id/${acao}`, async (req) => {
      const ctx = contextoDeAuditoria(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const d = z.object({ [campo]: z.string().trim().min(1).max(10000) }).strict().parse(req.body) as Record<string, string>;
      return comTransacao(pool, ctx, async (c) => {
        const r = await c.query(
          `UPDATE diligencia SET situacao = $2, resposta = $3, encerrada_em = now(), encerrada_por = $4 WHERE id = $1
           RETURNING id, emenda_id AS "emendaId", texto, prazo, situacao, resposta, encerrada_por AS "encerradaPor"`,
          [id, situacao, d[campo], ctx.usuario],
        );
        if (!r.rows[0]) throw new ErroNegocio(404, 'nao_encontrada', 'Diligência não encontrada');
        return r.rows[0];
      });
    });
  }
}
