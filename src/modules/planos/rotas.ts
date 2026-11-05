import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { dataIso, uuid } from '../../http/campos.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { ErroNegocio } from '../../http/erros.js';

type Db = Pick<PoolClient, 'query'> | Pick<Pool, 'query'>;

interface Marco {
  id: string;
  descricao: string;
  previstoPara: string;
  realizadoEm: string | null;
}
interface Item {
  id: string;
  ordem: number;
  descricao: string;
  unidade: string;
  quantidade: number;
  valorUnitarioCentavos: number;
  totalCentavos: number;
  marcos: Marco[];
}
interface Meta {
  id: string;
  ordem: number;
  descricao: string;
  totalCentavos: number;
  itens: Item[];
}
export interface Plano {
  id: string;
  emendaId: string;
  numero: number;
  situacao: 'rascunho' | 'vigente' | 'substituido';
  ativadoEm: string | null;
  totalCentavos: number;
  metas: Meta[];
}

const num = (v: string | number) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('valor fora do inteiro seguro');
  return n;
};

/** Carrega planos com metas, itens e marcos. Totais calculados em inteiros exatos. */
async function carregarPlanos(db: Db, filtro: { emendaId?: string; planoId?: string }): Promise<Plano[]> {
  const planos = await db.query<{ id: string; emenda_id: string; numero: number; situacao: Plano['situacao']; ativado_em: Date | null }>(
    `SELECT id, emenda_id, numero, situacao, ativado_em FROM plano_trabalho
     WHERE ($1::uuid IS NULL OR emenda_id = $1) AND ($2::uuid IS NULL OR id = $2) ORDER BY emenda_id, numero`,
    [filtro.emendaId ?? null, filtro.planoId ?? null],
  );
  if (!planos.rowCount) return [];
  const ids = planos.rows.map((p) => p.id);
  const metas = await db.query<{ id: string; plano_id: string; ordem: number; descricao: string }>(
    'SELECT id, plano_id, ordem, descricao FROM meta WHERE plano_id = ANY($1) ORDER BY ordem',
    [ids],
  );
  const itens = await db.query<{
    id: string; meta_id: string; ordem: number; descricao: string; unidade: string; quantidade: string; valor_unitario_centavos: string;
  }>(
    `SELECT i.id, i.meta_id, i.ordem, i.descricao, i.unidade, i.quantidade, i.valor_unitario_centavos
     FROM item_plano i JOIN meta m ON m.id = i.meta_id WHERE m.plano_id = ANY($1) ORDER BY i.ordem`,
    [ids],
  );
  const marcos = await db.query<{ id: string; item_id: string; descricao: string; previsto_para: string; realizado_em: string | null }>(
    `SELECT c.id, c.item_id, c.descricao, c.previsto_para, c.realizado_em
     FROM cronograma_marco c JOIN item_plano i ON i.id = c.item_id JOIN meta m ON m.id = i.meta_id
     WHERE m.plano_id = ANY($1) ORDER BY c.previsto_para, c.criado_em, c.id`,
    [ids],
  );

  return planos.rows.map((p) => {
    const ms: Meta[] = metas.rows
      .filter((m) => m.plano_id === p.id)
      .map((m) => {
        const its: Item[] = itens.rows
          .filter((i) => i.meta_id === m.id)
          .map((i) => {
            const quantidade = num(i.quantidade);
            const valorUnitarioCentavos = num(i.valor_unitario_centavos);
            return {
              id: i.id,
              ordem: i.ordem,
              descricao: i.descricao,
              unidade: i.unidade,
              quantidade,
              valorUnitarioCentavos,
              totalCentavos: quantidade * valorUnitarioCentavos,
              marcos: marcos.rows
                .filter((c) => c.item_id === i.id)
                .map((c) => ({ id: c.id, descricao: c.descricao, previstoPara: c.previsto_para, realizadoEm: c.realizado_em })),
            };
          });
        return { id: m.id, ordem: m.ordem, descricao: m.descricao, totalCentavos: its.reduce((a, i) => a + i.totalCentavos, 0), itens: its };
      });
    return {
      id: p.id,
      emendaId: p.emenda_id,
      numero: p.numero,
      situacao: p.situacao,
      ativadoEm: p.ativado_em ? p.ativado_em.toISOString() : null,
      totalCentavos: ms.reduce((a, m) => a + m.totalCentavos, 0),
      metas: ms,
    };
  });
}

async function planoOuErro(db: Db, id: string): Promise<Plano> {
  const [p] = await carregarPlanos(db, { planoId: id });
  if (!p) throw new ErroNegocio(404, 'nao_encontrado', 'Plano não encontrado');
  return p;
}

/** Plano que contém a meta / o item / o marco indicado. */
async function planoDe(db: Db, tabela: 'meta' | 'item_plano' | 'cronograma_marco', id: string): Promise<string> {
  const sql = {
    meta: 'SELECT plano_id AS p FROM meta WHERE id = $1',
    item_plano: 'SELECT m.plano_id AS p FROM item_plano i JOIN meta m ON m.id = i.meta_id WHERE i.id = $1',
    cronograma_marco:
      'SELECT m.plano_id AS p FROM cronograma_marco c JOIN item_plano i ON i.id = c.item_id JOIN meta m ON m.id = i.meta_id WHERE c.id = $1',
  }[tabela];
  const r = await db.query<{ p: string }>(sql, [id]);
  if (!r.rows[0]) throw new ErroNegocio(404, 'nao_encontrado', 'Registro não encontrado');
  return r.rows[0].p;
}

/**
 * Planos de trabalho. O conteúdo só muda com o plano em rascunho; ativar o plano congela o conteúdo
 * (mudança = nova versão). A única edição em plano vigente é registrar a data realizada de um marco.
 * Nenhum critério jurídico é aplicado: só consistência (itens existem, total <= valor da emenda).
 */
export function rotasPlanos(app: FastifyInstance, pool: Pool) {
  app.get('/emendas/:id/planos-trabalho', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return carregarPlanos(pool, { emendaId: id });
  });

  app.get('/planos-trabalho/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return planoOuErro(pool, id);
  });

  app.post('/emendas/:id/planos-trabalho', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const plano = await comTransacao(pool, ctx, async (c) => {
      const e = await c.query('SELECT 1 FROM emenda WHERE id = $1 FOR UPDATE', [id]);
      if (!e.rowCount) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
      const r = await c.query<{ id: string }>(
        `INSERT INTO plano_trabalho (emenda_id, numero)
         VALUES ($1, (SELECT coalesce(max(numero), 0) + 1 FROM plano_trabalho WHERE emenda_id = $1)) RETURNING id`,
        [id],
      );
      return planoOuErro(c, r.rows[0]!.id);
    });
    return reply.status(201).send(plano);
  });

  app.post('/planos-trabalho/:id/metas', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ descricao: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    const plano = await comTransacao(pool, ctx, async (c) => {
      await planoOuErro(c, id);
      await c.query(
        `INSERT INTO meta (plano_id, ordem, descricao)
         VALUES ($1, (SELECT coalesce(max(ordem), 0) + 1 FROM meta WHERE plano_id = $1), $2)`,
        [id, d.descricao],
      );
      return planoOuErro(c, id);
    });
    return reply.status(201).send(plano);
  });

  app.post('/metas/:id/itens', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({
        descricao: z.string().trim().min(1).max(2000),
        unidade: z.string().trim().min(1).max(60),
        quantidade: z.number().int().min(1).max(1_000_000_000),
        valorUnitarioCentavos: z.number().int().min(0).max(1_000_000_000_000),
      })
      .strict()
      .parse(req.body);
    const plano = await comTransacao(pool, ctx, async (c) => {
      const planoId = await planoDe(c, 'meta', id);
      await c.query(
        `INSERT INTO item_plano (meta_id, ordem, descricao, unidade, quantidade, valor_unitario_centavos)
         VALUES ($1, (SELECT coalesce(max(ordem), 0) + 1 FROM item_plano WHERE meta_id = $1), $2, $3, $4, $5)`,
        [id, d.descricao, d.unidade, d.quantidade, d.valorUnitarioCentavos],
      );
      return planoOuErro(c, planoId);
    });
    return reply.status(201).send(plano);
  });

  app.post('/itens/:id/marcos', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ descricao: z.string().trim().min(1).max(1000), previstoPara: dataIso }).strict().parse(req.body);
    const plano = await comTransacao(pool, ctx, async (c) => {
      const planoId = await planoDe(c, 'item_plano', id);
      await c.query('INSERT INTO cronograma_marco (item_id, descricao, previsto_para) VALUES ($1,$2,$3)', [
        id,
        d.descricao,
        d.previstoPara,
      ]);
      return planoOuErro(c, planoId);
    });
    return reply.status(201).send(plano);
  });

  // Remoções valem só em rascunho (o banco recusa nos demais casos).
  for (const [rota, tabela] of [
    ['metas', 'meta'],
    ['itens', 'item_plano'],
    ['marcos', 'cronograma_marco'],
  ] as const) {
    app.delete(`/${rota}/:id`, async (req) => {
      const ctx = contextoDeAuditoria(req);
      const { id } = z.object({ id: uuid }).parse(req.params);
      return comTransacao(pool, ctx, async (c) => {
        const planoId = await planoDe(c, tabela, id);
        if (tabela === 'meta') {
          const filhos = await c.query('SELECT 1 FROM item_plano WHERE meta_id = $1 LIMIT 1', [id]);
          if (filhos.rowCount) throw new ErroNegocio(409, 'possui_itens', 'Remova antes os itens da meta');
        }
        if (tabela === 'item_plano') {
          const filhos = await c.query('SELECT 1 FROM cronograma_marco WHERE item_id = $1 LIMIT 1', [id]);
          if (filhos.rowCount) throw new ErroNegocio(409, 'possui_marcos', 'Remova antes os marcos do item');
        }
        await c.query(`DELETE FROM ${tabela} WHERE id = $1`, [id]);
        return planoOuErro(c, planoId);
      });
    });
  }

  // Registrar (ou limpar) a data realizada de um marco: permitido também em plano vigente.
  app.patch('/marcos/:id', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ realizadoEm: dataIso.nullable() }).strict().parse(req.body);
    return comTransacao(pool, ctx, async (c) => {
      const planoId = await planoDe(c, 'cronograma_marco', id);
      await c.query('UPDATE cronograma_marco SET realizado_em = $2 WHERE id = $1', [id, d.realizadoEm]);
      return planoOuErro(c, planoId);
    });
  });

  // Ativa o plano; o plano vigente anterior passa a "substituido".
  app.post('/planos-trabalho/:id/ativar', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return comTransacao(pool, ctx, async (c) => {
      const p = await planoOuErro(c, id);
      await c.query('SELECT 1 FROM emenda WHERE id = $1 FOR UPDATE', [p.emendaId]);
      await c.query("UPDATE plano_trabalho SET situacao = 'substituido' WHERE emenda_id = $1 AND situacao = 'vigente'", [p.emendaId]);
      await c.query("UPDATE plano_trabalho SET situacao = 'vigente', ativado_em = now() WHERE id = $1", [id]);
      return planoOuErro(c, id);
    });
  });
}
