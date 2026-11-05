import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
const h = { 'x-usuario': 'rita' };

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

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });

async function novaBancada(nome: string) {
  const r = await post('/bancadas', { exercicioId: base.exercicioId, nome });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

describe('mandatos', () => {
  it('cadastra mandatos e recusa sobreposição para o mesmo parlamentar', async () => {
    const ok = await post(`/parlamentares/${base.p1}/mandatos`, { inicio: '2025-01-01', fim: '2028-12-31' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ inicio: '2025-01-01', fim: '2028-12-31' });
    const sobrepoe = await post(`/parlamentares/${base.p1}/mandatos`, { inicio: '2028-12-31', fim: '2030-01-01' });
    expect(sobrepoe.statusCode).toBe(409);
    expect(sobrepoe.json().erro).toBe('vigencia_sobreposta');
    const seguinte = await post(`/parlamentares/${base.p1}/mandatos`, { inicio: '2029-01-01' });
    expect(seguinte.statusCode).toBe(201);
  });

  it('valida datas: formato, calendário e fim anterior ao início', async () => {
    expect((await post(`/parlamentares/${base.p2}/mandatos`, { inicio: '01/02/2025' })).statusCode).toBe(400);
    expect((await post(`/parlamentares/${base.p2}/mandatos`, { inicio: '2026-02-30' })).statusCode).toBe(400);
    expect((await post(`/parlamentares/${base.p2}/mandatos`, { inicio: '2026-05-01', fim: '2026-04-01' })).statusCode).toBe(422);
  });
});

describe('bancadas e composição histórica', () => {
  it('consulta a composição em datas diferentes (aceite da fase)', async () => {
    const b = await novaBancada('Bancada Histórica');
    const m1 = await post(`/bancadas/${b}/membros`, { parlamentarId: base.p1, vigenciaInicio: '2025-01-01' });
    expect(m1.statusCode).toBe(201);
    await post(`/bancadas/${b}/membros`, { parlamentarId: base.p2, vigenciaInicio: '2026-07-01' });

    const compoe = async (data: string) =>
      (await app.inject({ method: 'GET', url: `/bancadas/${b}/composicao?data=${data}` })).json().membros.map((m: { nome: string }) => m.nome);

    expect(await compoe('2024-12-31')).toEqual([]);
    expect(await compoe('2025-06-15')).toEqual(['Teste A']);
    expect(await compoe('2026-07-01')).toEqual(['Teste A', 'Teste B']);

    // Encerrar vigência preserva o histórico: o membro continua nas datas passadas.
    const enc = await app.inject({
      method: 'PATCH',
      url: `/bancadas/${b}/membros/${m1.json().id}`,
      headers: h,
      payload: { vigenciaFim: '2026-12-31' },
    });
    expect(enc.statusCode).toBe(200);
    expect(await compoe('2026-12-31')).toEqual(['Teste A', 'Teste B']);
    expect(await compoe('2027-01-01')).toEqual(['Teste B']);
    expect(await compoe('2025-06-15')).toEqual(['Teste A']);

    // Já encerrado: não reescreve histórico.
    const de_novo = await app.inject({
      method: 'PATCH',
      url: `/bancadas/${b}/membros/${m1.json().id}`,
      headers: h,
      payload: { vigenciaFim: '2030-01-01' },
    });
    expect(de_novo.statusCode).toBe(404);
  });

  it('recusa vínculos sobrepostos do mesmo parlamentar na mesma bancada', async () => {
    const b = await novaBancada('Bancada Sobreposição');
    await post(`/bancadas/${b}/membros`, { parlamentarId: base.p1, vigenciaInicio: '2025-01-01', vigenciaFim: '2025-12-31' });
    const r = await post(`/bancadas/${b}/membros`, { parlamentarId: base.p1, vigenciaInicio: '2025-12-31' });
    expect(r.statusCode).toBe(409);
    // Reingresso depois do fim é permitido.
    expect((await post(`/bancadas/${b}/membros`, { parlamentarId: base.p1, vigenciaInicio: '2026-01-01' })).statusCode).toBe(201);
  });

  it('nome único por exercício; composição exige data; bancada inexistente é 404', async () => {
    await novaBancada('Duplicada');
    expect((await post('/bancadas', { exercicioId: base.exercicioId, nome: 'Duplicada' })).statusCode).toBe(409);
    const b = await novaBancada('Sem Data');
    expect((await app.inject({ method: 'GET', url: `/bancadas/${b}/composicao` })).statusCode).toBe(400);
    const nada = await app.inject({
      method: 'GET',
      url: '/bancadas/00000000-0000-0000-0000-000000000000/composicao?data=2026-01-01',
    });
    expect(nada.statusCode).toBe(404);
  });

  it('o banco recusa sobreposição mesmo sem passar pela API', async () => {
    const b = await novaBancada('Direto no Banco');
    const ins = (ini: string, fim: string | null) =>
      banco.pool.query(
        'INSERT INTO bancada_membro (bancada_id, parlamentar_id, vigencia_inicio, vigencia_fim) VALUES ($1,$2,$3,$4)',
        [b, base.p2, ini, fim],
      );
    await ins('2025-01-01', null);
    await expect(ins('2030-01-01', null)).rejects.toMatchObject({ code: '23P01' });
  });
});

describe('autoria por bancada', () => {
  it('emenda pode ter parlamentares e bancadas; bancada de outro exercício é recusada', async () => {
    const b = await novaBancada('Bancada Autora');
    const criar = await post('/emendas', {
      exercicioId: base.exercicioId,
      tipo: 'bancada',
      objeto: 'Projeto de bancada',
      valorPropostoCentavos: 100000,
      autores: [base.p1],
      bancadas: [b],
    });
    expect(criar.statusCode).toBe(201);
    expect(criar.json()).toMatchObject({ autores: [base.p1], bancadas: [b] });

    const outro = await banco.pool.query<{ id: string }>('INSERT INTO exercicio (ano) VALUES (2091) RETURNING id');
    const bOutro = await post('/bancadas', { exercicioId: outro.rows[0]!.id, nome: 'Outro Exercício' });
    const errada = await post('/emendas', {
      exercicioId: base.exercicioId,
      tipo: 'bancada',
      objeto: 'x',
      valorPropostoCentavos: 1,
      autores: [],
      bancadas: [bOutro.json().id],
    });
    expect(errada.statusCode).toBe(422);
  });

  it('só bancada é válido; nenhum autor é recusado; remover o último autor é recusado', async () => {
    const b = await novaBancada('Só Bancada');
    const ok = await post('/emendas', {
      exercicioId: base.exercicioId,
      tipo: 'bancada',
      objeto: 'y',
      valorPropostoCentavos: 5,
      autores: [],
      bancadas: [b],
    });
    expect(ok.statusCode).toBe(201);
    const nenhum = await post('/emendas', {
      exercicioId: base.exercicioId,
      tipo: 'individual',
      objeto: 'z',
      valorPropostoCentavos: 5,
      autores: [],
    });
    expect(nenhum.statusCode).toBe(400);

    const e = ok.json();
    const tira = await app.inject({
      method: 'PATCH',
      url: `/emendas/${e.id}`,
      headers: h,
      payload: { versaoEsperada: e.versao, bancadas: [] },
    });
    expect(tira.statusCode).toBe(422);
    const ainda = await app.inject({ method: 'GET', url: `/emendas/${e.id}` });
    expect(ainda.json()).toMatchObject({ versao: 1, bancadas: [b] });
  });

  it('uma linha de autoria tem exatamente um autor', async () => {
    const e = await post('/emendas', {
      exercicioId: base.exercicioId,
      tipo: 'individual',
      objeto: 'w',
      valorPropostoCentavos: 5,
      autores: [base.p1],
    });
    const b = await novaBancada('Dupla');
    await expect(
      banco.pool.query('INSERT INTO emenda_autoria (emenda_id, parlamentar_id, bancada_id) VALUES ($1,$2,$3)', [
        e.json().id,
        base.p2,
        b,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('parâmetros legais versionados', () => {
  const novo = (over: object = {}) => ({
    exercicioId: base.exercicioId,
    codigo: 'PARAMETRO_TESTE',
    valor: { x: 1 },
    vigenciaInicio: '2090-01-01',
    ...over,
  });

  it('nasce PENDENTE e não utilizável como regra', async () => {
    const r = await post('/parametros-legais', novo({ codigo: 'P_PENDENTE' }));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      statusValidacao: 'PENDENTE',
      utilizavelComoRegra: false,
      validadoPor: null,
      validadoEm: null,
    });
  });

  it('só valida com fonte normativa; registra validador e data', async () => {
    const p = (await post('/parametros-legais', novo({ codigo: 'P_VALIDA' }))).json();
    const semFonte = await post(`/parametros-legais/${p.id}/validacao`, { status: 'VALIDADO' });
    expect(semFonte.statusCode).toBe(422);

    const f = (await post('/fontes-normativas', { tipo: 'Lei', identificacao: '[FICTÍCIA] Lei de teste' })).json();
    const comFonte = (await post('/parametros-legais', novo({ codigo: 'P_VALIDA2', fonteNormativaId: f.id }))).json();
    const ok = await post(`/parametros-legais/${comFonte.id}/validacao`, { status: 'VALIDADO' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ statusValidacao: 'VALIDADO', validadoPor: 'rita', utilizavelComoRegra: true });
    expect(ok.json().validadoEm).toBeTruthy();

    const volta = await post(`/parametros-legais/${comFonte.id}/validacao`, { status: 'EM_CONFERENCIA' });
    expect(volta.json()).toMatchObject({ validadoPor: null, validadoEm: null, utilizavelComoRegra: false });
  });

  it('o banco recusa VALIDADO sem validador, data e fonte', async () => {
    const p = (await post('/parametros-legais', novo({ codigo: 'P_CHECK' }))).json();
    await expect(
      banco.pool.query("UPDATE parametro_legal SET status_validacao = 'VALIDADO' WHERE id = $1", [p.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('versões não se sobrepõem; encerrar a vigência permite a próxima; consulta por data', async () => {
    const v1 = (await post('/parametros-legais', novo({ codigo: 'P_VERSAO', valor: 'v1', vigenciaInicio: '2090-01-01' }))).json();
    const sobreposta = await post('/parametros-legais', novo({ codigo: 'P_VERSAO', valor: 'v2', vigenciaInicio: '2090-07-01' }));
    expect(sobreposta.statusCode).toBe(409);

    const enc = await post(`/parametros-legais/${v1.id}/encerrar`, { vigenciaFim: '2090-06-30' });
    expect(enc.statusCode).toBe(200);
    expect((await post('/parametros-legais', novo({ codigo: 'P_VERSAO', valor: 'v2', vigenciaInicio: '2090-07-01' }))).statusCode).toBe(201);

    const em = async (data: string) =>
      (await app.inject({ method: 'GET', url: `/parametros-legais?codigo=P_VERSAO&data=${data}` })).json().map((x: { valor: string }) => x.valor);
    expect(await em('2090-03-01')).toEqual(['v1']);
    expect(await em('2090-08-01')).toEqual(['v2']);
    expect(await em('2089-01-01')).toEqual([]);
  });

  it('o conteúdo é imutável no banco (valor, código, início)', async () => {
    const p = (await post('/parametros-legais', novo({ codigo: 'P_IMUTAVEL' }))).json();
    await expect(banco.pool.query(`UPDATE parametro_legal SET valor = '"outro"' WHERE id = $1`, [p.id])).rejects.toThrow(/imutável/);
    await expect(banco.pool.query(`UPDATE parametro_legal SET codigo = 'X' WHERE id = $1`, [p.id])).rejects.toThrow(/imutável/);
  });

  it('parâmetros NÃO influenciam emendas: nenhum bloqueio, limite ou cálculo', async () => {
    await post('/parametros-legais', novo({ codigo: 'LIMITE_FICTICIO', valor: { maximoCentavos: 1 } }));
    const r = await post('/emendas', {
      exercicioId: base.exercicioId,
      tipo: 'individual',
      objeto: 'Valor muito acima de qualquer parâmetro',
      valorPropostoCentavos: 9_000_000_000,
      autores: [base.p1],
    });
    expect(r.statusCode).toBe(201);
  });

  it('mudanças em bancadas, mandatos e parâmetros ficam na auditoria', async () => {
    const b = await novaBancada('Auditada');
    const eventos = await banco.pool.query(
      "SELECT acao, usuario, origem FROM auditoria_evento WHERE entidade = 'bancada' AND entidade_id = $1",
      [b],
    );
    expect(eventos.rows).toEqual([{ acao: 'criar', usuario: 'rita', origem: 'api' }]);
    const pa = (await post('/parametros-legais', novo({ codigo: 'P_AUDIT' }))).json();
    await post(`/parametros-legais/${pa.id}/validacao`, { status: 'EM_CONFERENCIA' });
    const ev = await banco.pool.query(
      "SELECT acao FROM auditoria_evento WHERE entidade = 'parametro_legal' AND entidade_id = $1 ORDER BY id",
      [pa.id],
    );
    expect(ev.rows.map((x) => x.acao)).toEqual(['criar', 'alterar']);
  });
});
