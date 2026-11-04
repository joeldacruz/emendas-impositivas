import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
const h = { 'x-usuario': 'revisor' };

beforeAll(async () => {
  banco = await criarBancoDeTeste();
  base = await criarBase(banco.pool);
  app = appDeTeste(banco.pool);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await banco.encerrar();
});

const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });
const patch = (url: string, payload: unknown) => app.inject({ method: 'PATCH', url, headers: h, payload: payload as object });
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: h });
const get = (url: string) => app.inject({ method: 'GET', url });

async function novaEmenda(valor = 1_000_000) {
  const r = await post('/emendas', {
    exercicioId: base.exercicioId,
    tipo: 'individual',
    objeto: 'Objeto',
    valorPropostoCentavos: valor,
    autores: [base.p1],
  });
  return r.json() as { id: string; versao: number };
}

/** Plano com 1 meta, 1 item (2 x valorUnitario) e 1 marco. Total = 2 x valorUnitario. */
async function planoCompleto(emendaId: string, valorUnitario = 10000) {
  const plano = (await post(`/emendas/${emendaId}/planos-trabalho`)).json();
  const comMeta = (await post(`/planos-trabalho/${plano.id}/metas`, { descricao: 'Meta 1' })).json();
  const metaId = comMeta.metas[0].id as string;
  const comItem = (await post(`/metas/${metaId}/itens`, { descricao: 'Item', unidade: 'un', quantidade: 2, valorUnitarioCentavos: valorUnitario })).json();
  const itemId = comItem.metas[0].itens[0].id as string;
  const comMarco = (await post(`/itens/${itemId}/marcos`, { descricao: 'Entrega', previstoPara: '2090-06-30' })).json();
  return { planoId: plano.id as string, metaId, itemId, marcoId: comMarco.metas[0].itens[0].marcos[0].id as string };
}

const auditoriaDe = async (emendaId: string) =>
  (await get(`/emendas/${emendaId}/auditoria`)).json() as { entidade: string; entidadeId: string; acao: string; usuario: string }[];

describe('correção 1: auditoria de metas, itens e marcos vinculada à emenda', () => {
  it('eventos de meta, item e marco aparecem em /emendas/:id/auditoria, cada um na emenda certa', async () => {
    const a = await novaEmenda();
    const b = await novaEmenda();
    const pa = await planoCompleto(a.id);
    const pb = await planoCompleto(b.id);

    const evA = await auditoriaDe(a.id);
    const evB = await auditoriaDe(b.id);
    for (const [entidade, id] of [['meta', pa.metaId], ['item_plano', pa.itemId], ['cronograma_marco', pa.marcoId]] as const) {
      expect(evA.filter((e) => e.entidade === entidade && e.entidadeId === id && e.acao === 'criar')).toHaveLength(1);
      expect(evB.some((e) => e.entidadeId === id)).toBe(false);
    }
    for (const [entidade, id] of [['meta', pb.metaId], ['item_plano', pb.itemId], ['cronograma_marco', pb.marcoId]] as const) {
      expect(evB.filter((e) => e.entidade === entidade && e.entidadeId === id && e.acao === 'criar')).toHaveLength(1);
      expect(evA.some((e) => e.entidadeId === id)).toBe(false);
    }
    expect(evA.find((e) => e.entidade === 'meta')?.usuario).toBe('revisor');
  });

  it('alteração (realizado do marco) e remoção (rascunho) também ficam vinculadas à emenda', async () => {
    const e = await novaEmenda();
    const p = await planoCompleto(e.id);
    const extra = (await post(`/itens/${p.itemId}/marcos`, { descricao: 'Extra', previstoPara: '2090-07-01' })).json();
    const extraId = extra.metas[0].itens[0].marcos.find((m: { descricao: string }) => m.descricao === 'Extra').id as string;
    expect((await del(`/marcos/${extraId}`)).statusCode).toBe(200);
    expect((await post(`/planos-trabalho/${p.planoId}/ativar`)).statusCode).toBe(200);
    expect((await patch(`/marcos/${p.marcoId}`, { realizadoEm: '2090-06-20' })).statusCode).toBe(200);

    const ev = await auditoriaDe(e.id);
    expect(ev.filter((x) => x.entidade === 'cronograma_marco' && x.entidadeId === p.marcoId).map((x) => x.acao)).toEqual(['criar', 'alterar']);
    expect(ev.filter((x) => x.entidade === 'cronograma_marco' && x.entidadeId === extraId).map((x) => x.acao)).toEqual(['criar', 'remover']);
  });

  it('nenhum evento de entidade da cadeia do plano fica sem emenda_id', async () => {
    const r = await banco.pool.query(
      "SELECT count(*)::int AS n FROM auditoria_evento WHERE entidade IN ('meta','item_plano','cronograma_marco') AND emenda_id IS NULL",
    );
    expect(r.rows[0].n).toBe(0);
  });
});

describe('correção 2: valor da emenda não pode cair abaixo do total do plano vigente', () => {
  it('rejeita a redução e preserva valor, versão e plano vigente', async () => {
    const e = await novaEmenda(50_000);
    const p = await planoCompleto(e.id, 10_000); // total 20.000
    expect((await post(`/planos-trabalho/${p.planoId}/ativar`)).statusCode).toBe(200);
    const antes = (await get(`/emendas/${e.id}`)).json();

    const r = await patch(`/emendas/${e.id}`, { versaoEsperada: antes.versao, valorPropostoCentavos: 19_999 });
    expect(r.statusCode).toBe(422);

    const depois = (await get(`/emendas/${e.id}`)).json();
    expect(depois.valorPropostoCentavos).toBe(50_000);
    expect(depois.versao).toBe(antes.versao);
    const plano = (await get(`/planos-trabalho/${p.planoId}`)).json();
    expect(plano).toMatchObject({ situacao: 'vigente', totalCentavos: 20_000 });
  });

  it('aceita reduzir até exatamente o total do plano vigente; rascunho e substituído não bloqueiam', async () => {
    const e = await novaEmenda(50_000);
    const v1 = await planoCompleto(e.id, 10_000); // 20.000
    await post(`/planos-trabalho/${v1.planoId}/ativar`);
    const v2 = await planoCompleto(e.id, 5_000); // 10.000, ainda rascunho
    let versao = (await get(`/emendas/${e.id}`)).json().versao as number;
    expect((await patch(`/emendas/${e.id}`, { versaoEsperada: versao, valorPropostoCentavos: 20_000 })).statusCode).toBe(200);
    versao += 1;
    // v2 substitui v1: agora o total vigente é 10.000
    expect((await post(`/planos-trabalho/${v2.planoId}/ativar`)).statusCode).toBe(200);
    expect((await patch(`/emendas/${e.id}`, { versaoEsperada: versao, valorPropostoCentavos: 10_000 })).statusCode).toBe(200);
    expect((await patch(`/emendas/${e.id}`, { versaoEsperada: versao + 1, valorPropostoCentavos: 9_999 })).statusCode).toBe(422);
  });

  it('a regra vale no banco, fora da API', async () => {
    const e = await novaEmenda(30_000);
    const p = await planoCompleto(e.id, 10_000);
    await post(`/planos-trabalho/${p.planoId}/ativar`);
    await expect(banco.pool.query('UPDATE emenda SET valor_proposto_centavos = 100 WHERE id = $1', [e.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('concorrência: ativar o plano x reduzir o valor nunca deixa plano vigente acima do valor', async () => {
    for (let i = 0; i < 12; i += 1) {
      const e = await novaEmenda(50_000);
      const p = await planoCompleto(e.id, 10_000); // total 20.000
      const versao = (await get(`/emendas/${e.id}`)).json().versao as number;
      const [ativacao, reducao] = await Promise.all([
        post(`/planos-trabalho/${p.planoId}/ativar`),
        patch(`/emendas/${e.id}`, { versaoEsperada: versao, valorPropostoCentavos: 15_000 }),
      ]);
      // exatamente um dos dois vence
      expect([ativacao.statusCode, reducao.statusCode].sort()).toEqual([200, 422]);

      const emenda = (await get(`/emendas/${e.id}`)).json();
      const plano = (await get(`/planos-trabalho/${p.planoId}`)).json();
      if (plano.situacao === 'vigente') {
        expect(emenda.valorPropostoCentavos).toBe(50_000);
        expect(emenda.versao).toBe(versao);
      } else {
        expect(plano.situacao).toBe('rascunho');
        expect(emenda.valorPropostoCentavos).toBe(15_000);
      }
      const inv = await banco.pool.query(
        `SELECT count(*)::int AS n FROM plano_trabalho p JOIN emenda e ON e.id = p.emenda_id
          WHERE p.situacao = 'vigente' AND e.id = $1
            AND (SELECT sum(i.quantidade::numeric * i.valor_unitario_centavos) FROM item_plano i JOIN meta m ON m.id = i.meta_id WHERE m.plano_id = p.id) > e.valor_proposto_centavos`,
        [e.id],
      );
      expect(inv.rows[0].n).toBe(0);
    }
  });

  it('concorrência no nível do banco (sem a trava da API): duas transações cruzadas', async () => {
    for (let i = 0; i < 8; i += 1) {
      const e = await novaEmenda(50_000);
      const p = await planoCompleto(e.id, 10_000);
      const c1 = await banco.pool.connect();
      const c2 = await banco.pool.connect();
      try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        // c1 ativa o plano e fica com a transação aberta (trava da emenda); só então c2 tenta reduzir o valor
        await c1.query("UPDATE plano_trabalho SET situacao = 'vigente', ativado_em = now() WHERE id = $1", [p.planoId]);
        const t2 = c2.query('UPDATE emenda SET valor_proposto_centavos = 15000 WHERE id = $1', [e.id]);
        const r2 = await Promise.race([Promise.allSettled([t2]), new Promise((res) => setTimeout(() => res('espera'), 300))]);
        expect(r2).toBe('espera'); // c2 está bloqueada esperando c1: não leu o plano antes do commit
        await c1.query('COMMIT');
        const r2b = await Promise.allSettled([t2]);
        await c2.query('ROLLBACK');
        expect(r2b[0]!.status).toBe('rejected');
      } finally {
        c1.release();
        c2.release();
      }
      const plano = (await get(`/planos-trabalho/${p.planoId}`)).json();
      const emenda = (await get(`/emendas/${e.id}`)).json();
      expect(plano.situacao).toBe('vigente');
      expect(emenda.valorPropostoCentavos).toBe(50_000);
    }
  });
});

describe('correção 2 (ordem inversa no banco): redução primeiro, ativação depois', () => {
  it('a ativação espera a redução e é rejeitada com o valor novo; o plano continua rascunho', async () => {
    for (let i = 0; i < 6; i += 1) {
      const e = await novaEmenda(50_000);
      const p = await planoCompleto(e.id, 10_000); // total 20.000
      const c1 = await banco.pool.connect();
      const c2 = await banco.pool.connect();
      try {
        await c2.query('BEGIN');
        await c1.query('BEGIN');
        await c2.query('UPDATE emenda SET valor_proposto_centavos = 15000 WHERE id = $1', [e.id]); // ainda sem plano vigente: aceita
        const t1 = c1.query("UPDATE plano_trabalho SET situacao = 'vigente', ativado_em = now() WHERE id = $1", [p.planoId]);
        const r1 = await Promise.race([Promise.allSettled([t1]), new Promise((res) => setTimeout(() => res('espera'), 300))]);
        expect(r1).toBe('espera');
        await c2.query('COMMIT');
        const r1b = await Promise.allSettled([t1]);
        await c1.query('ROLLBACK');
        expect(r1b[0]!.status).toBe('rejected');
        expect((r1b[0] as PromiseRejectedResult).reason).toMatchObject({ code: '23514' });
      } finally {
        c1.release();
        c2.release();
      }
      const plano = (await get(`/planos-trabalho/${p.planoId}`)).json();
      expect(plano.situacao).toBe('rascunho');
      expect((await get(`/emendas/${e.id}`)).json().valorPropostoCentavos).toBe(15_000);
    }
  });
});
