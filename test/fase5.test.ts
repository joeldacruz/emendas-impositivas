import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
const h = { 'x-usuario': 'paulo' };
const SHA = 'a'.repeat(64);

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

/** Cria plano com 1 meta, 1 item (2 x 100,00) e 1 marco. */
async function planoCompleto(emendaId: string, valorUnitario = 10000) {
  const plano = (await post(`/emendas/${emendaId}/planos-trabalho`)).json();
  const comMeta = (await post(`/planos-trabalho/${plano.id}/metas`, { descricao: 'Meta 1' })).json();
  const comItem = (await post(`/metas/${comMeta.metas[0].id}/itens`, { descricao: 'Item', unidade: 'un', quantidade: 2, valorUnitarioCentavos: valorUnitario })).json();
  const itemId = comItem.metas[0].itens[0].id;
  const comMarco = (await post(`/itens/${itemId}/marcos`, { descricao: 'Entrega', previstoPara: '2090-06-30' })).json();
  return { planoId: plano.id as string, metaId: comMeta.metas[0].id as string, itemId: itemId as string, marcoId: comMarco.metas[0].itens[0].marcos[0].id as string };
}

describe('planos de trabalho', () => {
  it('monta metas, itens e marcos com totais exatos', async () => {
    const e = await novaEmenda();
    const { planoId } = await planoCompleto(e.id);
    const p = (await get(`/planos-trabalho/${planoId}`)).json();
    expect(p).toMatchObject({ numero: 1, situacao: 'rascunho', totalCentavos: 20000 });
    expect(p.metas[0]).toMatchObject({ ordem: 1, totalCentavos: 20000 });
    expect(p.metas[0].itens[0]).toMatchObject({ ordem: 1, quantidade: 2, valorUnitarioCentavos: 10000, totalCentavos: 20000 });
    expect(p.metas[0].itens[0].marcos[0]).toMatchObject({ previstoPara: '2090-06-30', realizadoEm: null });
  });

  it('só ativa com itens e com total até o valor da emenda', async () => {
    const e = await novaEmenda(15000);
    const vazio = (await post(`/emendas/${e.id}/planos-trabalho`)).json();
    expect((await post(`/planos-trabalho/${vazio.id}/ativar`)).statusCode).toBe(422);
    const { planoId } = await planoCompleto(e.id, 10000); // total 20000 > 15000
    expect((await post(`/planos-trabalho/${planoId}/ativar`)).statusCode).toBe(422);
    const ok = await planoCompleto(e.id, 7500); // total 15000 = valor da emenda
    expect((await post(`/planos-trabalho/${ok.planoId}/ativar`)).statusCode).toBe(200);
  });

  it('plano vigente é congelado; nova versão substitui a anterior (um só vigente)', async () => {
    const e = await novaEmenda();
    const v1 = await planoCompleto(e.id);
    const ativo = await post(`/planos-trabalho/${v1.planoId}/ativar`);
    expect(ativo.json()).toMatchObject({ situacao: 'vigente' });
    expect(ativo.json().ativadoEm).toBeTruthy();

    // conteúdo congelado
    expect((await post(`/planos-trabalho/${v1.planoId}/metas`, { descricao: 'Outra' })).statusCode).toBe(422);
    expect((await post(`/metas/${v1.metaId}/itens`, { descricao: 'x', unidade: 'un', quantidade: 1, valorUnitarioCentavos: 1 })).statusCode).toBe(422);
    expect((await del(`/marcos/${v1.marcoId}`)).statusCode).toBe(422);
    expect((await post(`/planos-trabalho/${v1.planoId}/ativar`)).statusCode).toBe(422);

    // registrar realizado continua permitido
    const real = await patch(`/marcos/${v1.marcoId}`, { realizadoEm: '2090-07-02' });
    expect(real.statusCode).toBe(200);
    expect(real.json().metas[0].itens[0].marcos[0].realizadoEm).toBe('2090-07-02');

    // v2 em rascunho convive; ao ativar, v1 vira substituído
    const v2 = await planoCompleto(e.id, 5000);
    expect((await get(`/planos-trabalho/${v2.planoId}`)).json().numero).toBe(2);
    expect((await post(`/planos-trabalho/${v2.planoId}/ativar`)).statusCode).toBe(200);
    const planos = (await get(`/emendas/${e.id}/planos-trabalho`)).json() as { numero: number; situacao: string }[];
    expect(planos.map((p) => [p.numero, p.situacao])).toEqual([[1, 'substituido'], [2, 'vigente']]);

    // plano substituído não aceita mais nada, nem realizado
    expect((await patch(`/marcos/${v1.marcoId}`, { realizadoEm: '2090-08-01' })).statusCode).toBe(422);
    // o banco garante um único vigente
    await expect(banco.pool.query("UPDATE plano_trabalho SET situacao = 'vigente' WHERE id = $1", [v1.planoId])).rejects.toThrow();
  });

  it('em rascunho é possível remover (marco, item, meta, nessa ordem)', async () => {
    const e = await novaEmenda();
    const p = await planoCompleto(e.id);
    expect((await del(`/metas/${p.metaId}`)).statusCode).toBe(409);
    expect((await del(`/itens/${p.itemId}`)).statusCode).toBe(409);
    expect((await del(`/marcos/${p.marcoId}`)).statusCode).toBe(200);
    expect((await del(`/itens/${p.itemId}`)).statusCode).toBe(200);
    const final = await del(`/metas/${p.metaId}`);
    expect(final.statusCode).toBe(200);
    expect(final.json().metas).toEqual([]);
  });

  it('valida entradas e teto por item', async () => {
    const e = await novaEmenda();
    const { metaId } = await planoCompleto(e.id);
    const tenta = (o: object) => post(`/metas/${metaId}/itens`, { descricao: 'i', unidade: 'un', quantidade: 1, valorUnitarioCentavos: 1, ...o });
    expect((await tenta({ quantidade: 0 })).statusCode).toBe(400);
    expect((await tenta({ quantidade: 1.5 })).statusCode).toBe(400);
    expect((await tenta({ valorUnitarioCentavos: -1 })).statusCode).toBe(400);
    expect((await tenta({ quantidade: 1_000_000_000, valorUnitarioCentavos: 1_001 })).statusCode).toBe(422); // passa de 10 bi
    expect((await post(`/itens/${(await planoCompleto(e.id)).itemId}/marcos`, { descricao: 'm', previstoPara: '2090-02-30' })).statusCode).toBe(400);
    expect((await post('/metas/00000000-0000-0000-0000-000000000000/itens', { descricao: 'i', unidade: 'u', quantidade: 1, valorUnitarioCentavos: 1 })).statusCode).toBe(404);
  });

  it('mudanças ficam na auditoria', async () => {
    const e = await novaEmenda();
    const p = await planoCompleto(e.id);
    await post(`/planos-trabalho/${p.planoId}/ativar`);
    const r = await banco.pool.query(
      "SELECT acao, usuario FROM auditoria_evento WHERE entidade = 'plano_trabalho' AND entidade_id = $1 ORDER BY id",
      [p.planoId],
    );
    expect(r.rows).toEqual([{ acao: 'criar', usuario: 'paulo' }, { acao: 'alterar', usuario: 'paulo' }]);
  });
});

describe('tramitação neutra', () => {
  it('registra etapas livres com responsável e prazo informados; atraso é só comparação de datas', async () => {
    const e = await novaEmenda();
    const t = await post(`/emendas/${e.id}/tramitacao`, { titulo: 'Análise inicial', responsavel: 'Setor X', prazo: '2090-03-10' });
    expect(t.statusCode).toBe(201);
    const sem = await post(`/emendas/${e.id}/tramitacao`, { titulo: 'Sem prazo', responsavel: 'Setor Y' });
    expect(sem.statusCode).toBe(201);

    const antes = (await get(`/emendas/${e.id}/tramitacao?referencia=2090-03-10`)).json();
    expect(antes.map((x: { atrasada: boolean }) => x.atrasada)).toEqual([false, false]);
    const depois = (await get(`/emendas/${e.id}/tramitacao?referencia=2090-03-11`)).json();
    expect(depois.map((x: { atrasada: boolean }) => x.atrasada)).toEqual([true, false]);

    const conc = await post(`/tramitacao/${t.json().id}/concluir`);
    expect(conc.json()).toMatchObject({ situacao: 'concluida' });
    const apos = (await get(`/emendas/${e.id}/tramitacao?referencia=2095-01-01`)).json();
    expect(apos[0]).toMatchObject({ situacao: 'concluida', atrasada: false }); // encerrada não é atrasada

    // encerrada: não reabre nem encerra de novo
    expect((await post(`/tramitacao/${t.json().id}/cancelar`)).statusCode).toBe(422);
    expect((await post('/tramitacao/00000000-0000-0000-0000-000000000000/concluir')).statusCode).toBe(404);
  });

  it('conteúdo é imutável e o registro permanece (sem exclusão)', async () => {
    const e = await novaEmenda();
    const t = (await post(`/emendas/${e.id}/tramitacao`, { titulo: 'T', responsavel: 'R' })).json();
    await expect(banco.pool.query("UPDATE tramitacao SET titulo = 'outro' WHERE id = $1", [t.id])).rejects.toThrow(/imutável/);
    await expect(banco.pool.query('DELETE FROM tramitacao WHERE id = $1', [t.id])).rejects.toThrow(/permanente/);
  });
});

describe('pareceres e diligências', () => {
  it('parecer é permanente: não se edita nem se apaga', async () => {
    const e = await novaEmenda();
    const p = await post(`/emendas/${e.id}/pareceres`, { tipo: 'técnico', texto: 'Texto do parecer' });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ tipo: 'técnico', autor: 'paulo' });
    await expect(banco.pool.query("UPDATE parecer SET texto = 'x' WHERE id = $1", [p.json().id])).rejects.toThrow(/permanente/);
    await expect(banco.pool.query('DELETE FROM parecer WHERE id = $1', [p.json().id])).rejects.toThrow(/permanente/);
    await post(`/emendas/${e.id}/pareceres`, { tipo: 'técnico', texto: 'Segunda opinião' });
    expect(((await get(`/emendas/${e.id}/pareceres`)).json() as unknown[]).length).toBe(2);
    expect((await post(`/emendas/${e.id}/pareceres`, { tipo: 'x' })).statusCode).toBe(400);
  });

  it('diligência: aberta -> atendida (com resposta) ou cancelada (com motivo); encerrada não muda', async () => {
    const e = await novaEmenda();
    const d1 = (await post(`/emendas/${e.id}/diligencias`, { texto: 'Complementar documento', prazo: '2090-05-01' })).json();
    expect(d1).toMatchObject({ situacao: 'aberta', abertaPor: 'paulo' });
    expect((await post(`/diligencias/${d1.id}/atender`, {})).statusCode).toBe(400);
    const at = await post(`/diligencias/${d1.id}/atender`, { resposta: 'Documento anexado' });
    expect(at.json()).toMatchObject({ situacao: 'atendida', resposta: 'Documento anexado', encerradaPor: 'paulo' });
    expect((await post(`/diligencias/${d1.id}/cancelar`, { motivo: 'tarde' })).statusCode).toBe(422);

    const d2 = (await post(`/emendas/${e.id}/diligencias`, { texto: 'Outra' })).json();
    expect((await post(`/diligencias/${d2.id}/cancelar`, { motivo: 'Aberta por engano' })).json()).toMatchObject({ situacao: 'cancelada' });

    const lista = (await get(`/emendas/${e.id}/diligencias?referencia=2090-06-01`)).json();
    expect(lista.map((x: { situacao: string; atrasada: boolean }) => [x.situacao, x.atrasada])).toEqual([['atendida', false], ['cancelada', false]]);
    await expect(banco.pool.query("UPDATE diligencia SET texto = 'x' WHERE id = $1", [d2.id])).rejects.toThrow(/imutável/);
    await expect(banco.pool.query('DELETE FROM diligencia WHERE id = $1', [d2.id])).rejects.toThrow(/permanente/);
  });

  it('diligência aberta vencida aparece como atrasada', async () => {
    const e = await novaEmenda();
    await post(`/emendas/${e.id}/diligencias`, { texto: 'Vence', prazo: '2090-01-10' });
    const l = (await get(`/emendas/${e.id}/diligencias?referencia=2090-01-11`)).json();
    expect(l[0].atrasada).toBe(true);
  });
});

describe('documentos (metadados)', () => {
  const doc = (over: object = {}) => ({ nomeArquivo: 'oficio.pdf', tipoMime: 'application/pdf', tamanhoBytes: 1234, sha256: SHA, ...over });

  it('registra metadados como interno e valida o hash', async () => {
    const e = await novaEmenda();
    const r = await post(`/emendas/${e.id}/documentos`, doc());
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ classificacao: 'interno', registradoPor: 'paulo', tamanhoBytes: 1234, sha256: SHA });
    expect((await post(`/emendas/${e.id}/documentos`, doc({ sha256: 'xyz' }))).statusCode).toBe(400);
    expect((await post(`/emendas/${e.id}/documentos`, doc({ sha256: 'A'.repeat(64) }))).statusCode).toBe(400);
    expect((await post(`/emendas/${e.id}/documentos`, doc({ tamanhoBytes: -1 }))).statusCode).toBe(400);
  });

  it('vincula a parecer/diligência da mesma emenda, nunca de outra', async () => {
    const e = await novaEmenda();
    const outra = await novaEmenda();
    const par = (await post(`/emendas/${e.id}/pareceres`, { tipo: 't', texto: 'x' })).json();
    const dil = (await post(`/emendas/${outra.id}/diligencias`, { texto: 'y' })).json();
    expect((await post(`/emendas/${e.id}/documentos`, doc({ parecerId: par.id }))).statusCode).toBe(201);
    expect((await post(`/emendas/${e.id}/documentos`, doc({ diligenciaId: dil.id }))).statusCode).toBe(422);
    expect((await post(`/emendas/${e.id}/documentos`, doc({ parecerId: par.id, diligenciaId: dil.id }))).statusCode).toBe(400);
  });

  it('classificação só muda com justificativa e fica auditada; metadados são imutáveis', async () => {
    const e = await novaEmenda();
    const d = (await post(`/emendas/${e.id}/documentos`, doc())).json();
    expect((await post(`/documentos/${d.id}/classificacao`, { classificacao: 'publicavel' })).statusCode).toBe(400);
    const pub = await post(`/documentos/${d.id}/classificacao`, { classificacao: 'publicavel', justificativa: 'Parecer jurídico autorizou' });
    expect(pub.json()).toMatchObject({ classificacao: 'publicavel', classificacaoJustificativa: 'Parecer jurídico autorizou' });
    const ev = await banco.pool.query("SELECT acao, antes->>'classificacao' AS antes, depois->>'classificacao' AS depois FROM auditoria_evento WHERE entidade = 'documento' AND entidade_id = $1 ORDER BY id", [d.id]);
    expect(ev.rows.at(-1)).toEqual({ acao: 'alterar', antes: 'interno', depois: 'publicavel' });
    await expect(banco.pool.query("UPDATE documento SET sha256 = $2 WHERE id = $1", [d.id, 'b'.repeat(64)])).rejects.toThrow(/imutáveis/);
    await expect(banco.pool.query("UPDATE documento SET classificacao = 'interno' WHERE id = $1", [d.id])).rejects.toMatchObject({ code: '23514' }); // reaproveitar a justificativa antiga não vale
    await expect(banco.pool.query('DELETE FROM documento WHERE id = $1', [d.id])).rejects.toThrow(/permanente/);
  });
});

describe('emenda cancelada congela tudo da Fase 5', () => {
  it('nenhum registro novo nem alteração em plano, tramitação, parecer, diligência ou documento', async () => {
    const e = await novaEmenda();
    const p = await planoCompleto(e.id);
    await post(`/planos-trabalho/${p.planoId}/ativar`);
    const t = (await post(`/emendas/${e.id}/tramitacao`, { titulo: 'T', responsavel: 'R' })).json();
    const dil = (await post(`/emendas/${e.id}/diligencias`, { texto: 'D' })).json();
    expect((await post(`/emendas/${e.id}/cancelar`, { versaoEsperada: e.versao, motivo: 'Cancelada no teste' })).statusCode).toBe(200);

    const resultados = [
      await post(`/emendas/${e.id}/planos-trabalho`),
      await patch(`/marcos/${p.marcoId}`, { realizadoEm: '2090-07-02' }),
      await post(`/emendas/${e.id}/tramitacao`, { titulo: 'N', responsavel: 'R' }),
      await post(`/tramitacao/${t.id}/concluir`),
      await post(`/emendas/${e.id}/pareceres`, { tipo: 't', texto: 'x' }),
      await post(`/emendas/${e.id}/diligencias`, { texto: 'N' }),
      await post(`/diligencias/${dil.id}/atender`, { resposta: 'r' }),
      await post(`/emendas/${e.id}/documentos`, { nomeArquivo: 'a', tipoMime: 'text/plain', tamanhoBytes: 1, sha256: SHA }),
    ];
    expect(resultados.map((r) => r.statusCode)).toEqual(Array(8).fill(422));
    // mas a leitura segue disponível
    expect((await get(`/emendas/${e.id}/planos-trabalho`)).statusCode).toBe(200);
    expect((await get(`/emendas/${e.id}/tramitacao`)).statusCode).toBe(200);
  });
});
