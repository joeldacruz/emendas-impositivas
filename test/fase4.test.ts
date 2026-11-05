import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
const h = { 'x-usuario': 'carla' };

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
const del = (url: string) => app.inject({ method: 'DELETE', url, headers: h });
const get = (url: string) => app.inject({ method: 'GET', url });

async function novaEmenda(valor = 100000) {
  const r = await post('/emendas', {
    exercicioId: base.exercicioId,
    tipo: 'individual',
    objeto: 'Objeto',
    valorPropostoCentavos: valor,
    autores: [base.p1],
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}
async function novoBeneficiario(over: object = {}) {
  const r = await post('/beneficiarios', { nome: 'Entidade Teste', tipo: 'pessoa_juridica', ...over });
  expect(r.statusCode).toBe(201);
  return r.json();
}

describe('beneficiários', () => {
  it('cadastra e valida documento (11 ou 14 dígitos, sem pontuação) e unicidade', async () => {
    const b = await novoBeneficiario({ documento: '12345678000199' });
    expect(b).toMatchObject({ nome: 'Entidade Teste', documento: '12345678000199' });
    expect((await post('/beneficiarios', { nome: 'X', tipo: 'outro', documento: '12.345.678/0001-99' })).statusCode).toBe(400);
    expect((await post('/beneficiarios', { nome: 'X', tipo: 'outro', documento: '123' })).statusCode).toBe(400);
    expect((await post('/beneficiarios', { nome: 'Dup', tipo: 'outro', documento: '12345678000199' })).statusCode).toBe(409);
    expect((await post('/beneficiarios', { nome: 'X', tipo: 'invalido' })).statusCode).toBe(400);
    expect((await get(`/beneficiarios/${b.id}`)).statusCode).toBe(200);
  });

  it('vincula à emenda com valor e respeita a soma máxima (valor proposto)', async () => {
    const e = await novaEmenda(100000);
    const b1 = await novoBeneficiario();
    const b2 = await novoBeneficiario();
    const b3 = await novoBeneficiario();
    expect((await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b1.id, valorCentavos: 60000 })).statusCode).toBe(201);
    expect((await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b2.id, valorCentavos: 40000 })).statusCode).toBe(201);
    // soma passaria de 100000
    expect((await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b3.id, valorCentavos: 1 })).statusCode).toBe(422);
    // sem valor definido é permitido
    expect((await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b3.id })).statusCode).toBe(201);
    // duplicado
    expect((await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b1.id })).statusCode).toBe(409);

    const lida = (await get(`/emendas/${e.id}`)).json();
    expect(lida.beneficiarios).toEqual([
      { beneficiarioId: b1.id, valorCentavos: 60000 },
      { beneficiarioId: b2.id, valorCentavos: 40000 },
      { beneficiarioId: b3.id, valorCentavos: null },
    ]);

    // não deixa reduzir o valor proposto abaixo da soma destinada
    const reduz = await app.inject({
      method: 'PATCH',
      url: `/emendas/${e.id}`,
      headers: h,
      payload: { versaoEsperada: 1, valorPropostoCentavos: 90000 },
    });
    expect(reduz.statusCode).toBe(422);

    // remover libera espaço
    expect((await del(`/emendas/${e.id}/beneficiarios/${b2.id}`)).statusCode).toBe(200);
    expect((await del(`/emendas/${e.id}/beneficiarios/${b2.id}`)).statusCode).toBe(404);
    const ok = await app.inject({
      method: 'PATCH',
      url: `/emendas/${e.id}`,
      headers: h,
      payload: { versaoEsperada: 1, valorPropostoCentavos: 90000 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('a soma máxima vale também sob concorrência (duas inclusões simultâneas)', async () => {
    const e = await novaEmenda(100);
    const bs = await Promise.all([novoBeneficiario(), novoBeneficiario(), novoBeneficiario(), novoBeneficiario()]);
    const resp = await Promise.all(bs.map((b) => post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b.id, valorCentavos: 40 })));
    expect(resp.filter((r) => r.statusCode === 201)).toHaveLength(2);
    const soma = await banco.pool.query('SELECT sum(valor_centavos)::int AS s FROM emenda_beneficiario WHERE emenda_id = $1', [e.id]);
    expect(soma.rows[0].s).toBe(80);
  });

  it('vínculos de beneficiário ficam na auditoria da emenda', async () => {
    const e = await novaEmenda();
    const b = await novoBeneficiario();
    await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b.id, valorCentavos: 10 });
    await del(`/emendas/${e.id}/beneficiarios/${b.id}`);
    const ev = (await get(`/emendas/${e.id}/auditoria`)).json() as { entidade: string; acao: string; usuario: string }[];
    const ben = ev.filter((x) => x.entidade === 'emenda_beneficiario');
    expect(ben.map((x) => x.acao)).toEqual(['criar', 'remover']);
    expect(ben.every((x) => x.usuario === 'carla')).toBe(true);
  });
});

describe('identificadores externos', () => {
  it('vincula identificadores sem alterar o ID interno; único por sistema/tipo/valor', async () => {
    const e = await novaEmenda();
    const r = await post(`/emendas/${e.id}/identificadores-externos`, { sistema: 'ipm', tipoId: 'emenda', valorId: 'X-100' });
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe(e.id);
    expect(r.json().identificadoresExternos).toMatchObject([{ sistema: 'ipm', tipoId: 'emenda', valorId: 'X-100' }]);

    const outra = await novaEmenda();
    const dup = await post(`/emendas/${outra.id}/identificadores-externos`, { sistema: 'ipm', tipoId: 'emenda', valorId: 'X-100' });
    expect(dup.statusCode).toBe(409);

    const idExt = r.json().identificadoresExternos[0].id;
    const rem = await del(`/emendas/${e.id}/identificadores-externos/${idExt}`);
    expect(rem.statusCode).toBe(200);
    expect(rem.json().identificadoresExternos).toEqual([]);
    expect((await del(`/emendas/${e.id}/identificadores-externos/${idExt}`)).statusCode).toBe(404);
  });
});

describe('número oficial', () => {
  it('é separado do ID interno, pode ser definido depois e é único no exercício', async () => {
    const e = await novaEmenda();
    expect(e.numeroOficial).toBeNull();
    const p = await app.inject({ method: 'PATCH', url: `/emendas/${e.id}`, headers: h, payload: { versaoEsperada: 1, numeroOficial: 'N-77' } });
    expect(p.json()).toMatchObject({ id: e.id, numeroOficial: 'N-77' });
    const outra = await novaEmenda();
    const dup = await app.inject({ method: 'PATCH', url: `/emendas/${outra.id}`, headers: h, payload: { versaoEsperada: 1, numeroOficial: 'N-77' } });
    expect(dup.statusCode).toBe(409);
  });
});

describe('situação e cancelamento lógico', () => {
  it('rascunho -> cadastrada -> cancelada, com motivo, e depois congelada', async () => {
    const e = await novaEmenda();
    expect(e.situacao).toBe('rascunho');

    const cad = await post(`/emendas/${e.id}/cadastrar`, { versaoEsperada: 1 });
    expect(cad.statusCode).toBe(200);
    expect(cad.json()).toMatchObject({ situacao: 'cadastrada', versao: 2 });

    // edição ainda permitida enquanto cadastrada
    const ed = await app.inject({ method: 'PATCH', url: `/emendas/${e.id}`, headers: h, payload: { versaoEsperada: 2, objeto: 'Objeto ajustado' } });
    expect(ed.statusCode).toBe(200);

    expect((await post(`/emendas/${e.id}/cancelar`, { versaoEsperada: 3 })).statusCode).toBe(400);
    expect((await post(`/emendas/${e.id}/cancelar`, { versaoEsperada: 3, motivo: 'ab' })).statusCode).toBe(400);
    const can = await post(`/emendas/${e.id}/cancelar`, { versaoEsperada: 3, motivo: 'Cadastrada por engano' });
    expect(can.statusCode).toBe(200);
    expect(can.json()).toMatchObject({ situacao: 'cancelada', cancelamentoMotivo: 'Cadastrada por engano' });
    expect(can.json().canceladaEm).toBeTruthy();

    // congelada: nenhuma alteração, em nenhuma parte
    const b = await post('/beneficiarios', { nome: 'Z', tipo: 'outro' });
    const tenta = [
      await app.inject({ method: 'PATCH', url: `/emendas/${e.id}`, headers: h, payload: { versaoEsperada: 4, objeto: 'x' } }),
      await app.inject({ method: 'PATCH', url: `/emendas/${e.id}`, headers: h, payload: { versaoEsperada: 4, autores: [base.p2] } }),
      await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b.json().id }),
      await post(`/emendas/${e.id}/identificadores-externos`, { sistema: 's', tipoId: 't', valorId: 'v' }),
      await post(`/emendas/${e.id}/cadastrar`, { versaoEsperada: 4 }),
      await post(`/emendas/${e.id}/cancelar`, { versaoEsperada: 4, motivo: 'de novo' }),
    ];
    expect(tenta.map((r) => r.statusCode)).toEqual([422, 422, 422, 422, 422, 422]);

    // a emenda e o histórico continuam consultáveis
    const lida = (await get(`/emendas/${e.id}`)).json();
    expect(lida).toMatchObject({ situacao: 'cancelada', objeto: 'Objeto ajustado', autores: [base.p1] });
    const acoes = ((await get(`/emendas/${e.id}/auditoria`)).json() as { acao: string }[]).map((x) => x.acao);
    expect(acoes.filter((a) => a === 'alterar')).toHaveLength(3); // cadastrar, editar, cancelar
  });

  it('cancela direto do rascunho; não volta de cadastrada para rascunho (nem por SQL)', async () => {
    const e = await novaEmenda();
    expect((await post(`/emendas/${e.id}/cancelar`, { versaoEsperada: 1, motivo: 'Desistência' })).statusCode).toBe(200);

    const f = await novaEmenda();
    await post(`/emendas/${f.id}/cadastrar`, { versaoEsperada: 1 });
    await expect(banco.pool.query("UPDATE emenda SET situacao = 'rascunho' WHERE id = $1", [f.id])).rejects.toThrow(/transição/);
    await expect(
      banco.pool.query("UPDATE emenda SET situacao = 'cancelada' WHERE id = $1", [f.id]),
    ).rejects.toMatchObject({ code: '23514' }); // sem motivo/data: CHECK de coerência
  });

  it('cadastrar exige a versão atual', async () => {
    const e = await novaEmenda();
    expect((await post(`/emendas/${e.id}/cadastrar`, { versaoEsperada: 9 })).statusCode).toBe(409);
    expect((await post('/emendas/00000000-0000-0000-0000-000000000000/cadastrar', { versaoEsperada: 1 })).statusCode).toBe(404);
  });
});

describe('ciclo completo (aceite da fase)', () => {
  it('cadastro, edição, beneficiário, identificador, cadastro e cancelamento, tudo auditado', async () => {
    const b = await novoBeneficiario({ nome: 'Associação Exemplo' });
    const e = await novaEmenda(500000);
    await app.inject({ method: 'PATCH', url: `/emendas/${e.id}`, headers: h, payload: { versaoEsperada: 1, numeroOficial: 'CICLO-1', objeto: 'Objeto final' } });
    await post(`/emendas/${e.id}/beneficiarios`, { beneficiarioId: b.id, valorCentavos: 500000 });
    await post(`/emendas/${e.id}/identificadores-externos`, { sistema: 'ipm', tipoId: 'emenda', valorId: 'CICLO-1' });
    await post(`/emendas/${e.id}/cadastrar`, { versaoEsperada: 2 });
    const final = (await get(`/emendas/${e.id}`)).json();
    expect(final).toMatchObject({
      numeroOficial: 'CICLO-1',
      situacao: 'cadastrada',
      beneficiarios: [{ beneficiarioId: b.id, valorCentavos: 500000 }],
    });
    const ev = (await get(`/emendas/${e.id}/auditoria`)).json() as { entidade: string; acao: string }[];
    const tipos = new Set(ev.map((x) => x.entidade));
    expect(tipos).toEqual(new Set(['emenda', 'emenda_autoria', 'emenda_beneficiario', 'emenda_identificador_externo']));
    expect(ev.every((x) => ['criar', 'alterar', 'remover'].includes(x.acao))).toBe(true);
  });
});
