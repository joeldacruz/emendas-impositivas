import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
const h = { 'x-usuario': 'ana' };

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

const corpo = () => ({
  exercicioId: base.exercicioId,
  tipo: 'individual',
  objeto: 'Compra de exemplo',
  valorPropostoCentavos: 13450,
  autores: [base.p1, base.p2],
});

describe('GET /saude', () => {
  it('responde ok com banco disponível', async () => {
    const r = await app.inject({ method: 'GET', url: '/saude' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', banco: 'ok', ambiente: 'teste' });
  });

  it('responde 503 quando o banco está indisponível', async () => {
    const quebrado = appDeTeste({ query: () => Promise.reject(new Error('x')) } as never);
    const r = await quebrado.inject({ method: 'GET', url: '/saude' });
    expect(r.statusCode).toBe(503);
    expect(r.json().status).toBe('degradado');
  });
});

describe('emendas', () => {
  it('cria, lê, altera com controle de versão e lista a auditoria', async () => {
    const c = await app.inject({ method: 'POST', url: '/emendas', headers: h, payload: corpo() });
    expect(c.statusCode).toBe(201);
    const e = c.json();
    expect(e).toMatchObject({ valorPropostoCentavos: 13450, versao: 1, situacao: 'rascunho' });
    expect(e.autores).toHaveLength(2);

    const g = await app.inject({ method: 'GET', url: `/emendas/${e.id}` });
    expect(g.json().id).toBe(e.id);

    const p = await app.inject({
      method: 'PATCH',
      url: `/emendas/${e.id}`,
      headers: h,
      payload: { versaoEsperada: 1, objeto: 'Objeto novo' },
    });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ objeto: 'Objeto novo', versao: 2 });

    const velho = await app.inject({
      method: 'PATCH',
      url: `/emendas/${e.id}`,
      headers: h,
      payload: { versaoEsperada: 1, objeto: 'Outro' },
    });
    expect(velho.statusCode).toBe(409);

    const a = await app.inject({ method: 'GET', url: `/emendas/${e.id}/auditoria` });
    const eventos = a.json() as { entidade: string; acao: string; usuario: string }[];
    expect(eventos.filter((x) => x.entidade === 'emenda').map((x) => x.acao)).toEqual(['criar', 'alterar']);
    expect(eventos.every((x) => x.usuario === 'ana')).toBe(true);
  });

  it('exige X-Usuario nas escritas', async () => {
    const r = await app.inject({ method: 'POST', url: '/emendas', payload: corpo() });
    expect(r.statusCode).toBe(400);
    expect(r.json().erro).toBe('usuario_obrigatorio');
  });

  it('valida entrada: valor decimal, negativo, sem autores, campos extras', async () => {
    const tenta = (p: object) => app.inject({ method: 'POST', url: '/emendas', headers: h, payload: { ...corpo(), ...p } });
    expect((await tenta({ valorPropostoCentavos: 10.5 })).statusCode).toBe(400);
    expect((await tenta({ valorPropostoCentavos: -1 })).statusCode).toBe(400);
    expect((await tenta({ autores: [] })).statusCode).toBe(400);
    expect((await tenta({ autores: [base.p1, base.p1] })).statusCode).toBe(400);
    expect((await tenta({ id: '11111111-1111-1111-1111-111111111111' })).statusCode).toBe(400);
  });

  it('referência inexistente vira 422 e não deixa resíduo', async () => {
    const antes = await banco.pool.query('SELECT count(*)::int AS n FROM emenda');
    const r = await app.inject({
      method: 'POST',
      url: '/emendas',
      headers: h,
      payload: { ...corpo(), autores: ['00000000-0000-0000-0000-000000000000'] },
    });
    expect(r.statusCode).toBe(422);
    const depois = await banco.pool.query('SELECT count(*)::int AS n FROM emenda');
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });

  it('número oficial duplicado no exercício retorna 409', async () => {
    const p = { ...corpo(), numeroOficial: 'API-1' };
    expect((await app.inject({ method: 'POST', url: '/emendas', headers: h, payload: p })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/emendas', headers: h, payload: p })).statusCode).toBe(409);
  });

  it('404 para emenda inexistente', async () => {
    const r = await app.inject({ method: 'GET', url: '/emendas/00000000-0000-0000-0000-000000000000' });
    expect(r.statusCode).toBe(404);
  });
});

describe('auditoria é somente leitura na interface', () => {
  it('não existem rotas para criar, alterar ou excluir eventos nem excluir emendas', async () => {
    const { id } = (await app.inject({ method: 'POST', url: '/emendas', headers: h, payload: corpo() })).json();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await app.inject({ method, url: `/emendas/${id}/auditoria`, headers: h, payload: {} });
      expect(r.statusCode, `${method} /auditoria`).toBe(404);
    }
    expect((await app.inject({ method: 'DELETE', url: `/emendas/${id}`, headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/auditoria/1', headers: h })).statusCode).toBe(404);
  });
});
