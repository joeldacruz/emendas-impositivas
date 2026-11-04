import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comTransacao } from '../src/db/transacao.js';
import { alterarEmenda, criarEmenda, listarAuditoriaDaEmenda } from '../src/modules/emendas/repositorio.js';
import { criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let base: Awaited<ReturnType<typeof criarBase>>;

beforeAll(async () => {
  banco = await criarBancoDeTeste();
  base = await criarBase(banco.pool);
});
afterAll(async () => banco.encerrar());

const ctx = { usuario: 'maria', origem: 'api' };
const nova = () => ({
  exercicioId: base.exercicioId,
  tipo: 'individual' as const,
  objeto: 'Objeto',
  valorPropostoCentavos: 12345,
  autores: [base.p1],
});

describe('auditoria de emendas', () => {
  it('registra criação da emenda e da autoria, com usuário e origem', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    const ev = await listarAuditoriaDaEmenda(banco.pool, e.id);
    expect(ev.map((x) => [x.entidade, x.acao, x.usuario, x.origem])).toEqual([
      ['emenda', 'criar', 'maria', 'api'],
      ['emenda_autoria', 'criar', 'maria', 'api'],
    ]);
    expect(ev[0]!.antes).toBeNull();
    expect(ev[0]!.depois).toMatchObject({ id: e.id, valor_proposto_centavos: 12345 });
  });

  it('registra alteração com antes e depois', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    await comTransacao(banco.pool, { usuario: 'joao', origem: 'api' }, (c) =>
      alterarEmenda(c, e.id, { versaoEsperada: 1, objeto: 'Objeto alterado', valorPropostoCentavos: 999 }),
    );
    const alt = (await listarAuditoriaDaEmenda(banco.pool, e.id)).filter((x) => x.entidade === 'emenda' && x.acao === 'alterar');
    expect(alt).toHaveLength(1);
    expect(alt[0]).toMatchObject({ usuario: 'joao' });
    expect(alt[0]!.antes).toMatchObject({ objeto: 'Objeto', valor_proposto_centavos: 12345, versao: 1 });
    expect(alt[0]!.depois).toMatchObject({ objeto: 'Objeto alterado', valor_proposto_centavos: 999, versao: 2 });
  });

  it('registra troca de autoria (inclusão e remoção) e avança a versão', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    const depois = await comTransacao(banco.pool, ctx, (c) =>
      alterarEmenda(c, e.id, { versaoEsperada: 1, autores: [base.p2] }),
    );
    expect(depois.autores).toEqual([base.p2]);
    expect(depois.versao).toBe(2);
    const ev = await listarAuditoriaDaEmenda(banco.pool, e.id);
    const acoes = ev.filter((x) => x.entidade === 'emenda_autoria').map((x) => x.acao);
    expect(acoes).toEqual(['criar', 'remover', 'criar']);
  });

  it('rejeita alteração com versão desatualizada sem gravar nada', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    await comTransacao(banco.pool, ctx, (c) => alterarEmenda(c, e.id, { versaoEsperada: 1, objeto: 'v2' }));
    const antes = (await listarAuditoriaDaEmenda(banco.pool, e.id)).length;
    await expect(
      comTransacao(banco.pool, ctx, (c) => alterarEmenda(c, e.id, { versaoEsperada: 1, objeto: 'v3' })),
    ).rejects.toMatchObject({ status: 409 });
    expect((await listarAuditoriaDaEmenda(banco.pool, e.id)).length).toBe(antes);
  });

  it('transação com falha não deixa evento de auditoria', async () => {
    const antes = await banco.pool.query('SELECT count(*)::int AS n FROM auditoria_evento');
    await expect(
      comTransacao(banco.pool, ctx, async (c) => {
        await criarEmenda(c, nova());
        throw new Error('falha proposital');
      }),
    ).rejects.toThrow('falha proposital');
    const depois = await banco.pool.query('SELECT count(*)::int AS n FROM auditoria_evento');
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });

  it('alteração sem efeito não gera evento', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    const antes = (await listarAuditoriaDaEmenda(banco.pool, e.id)).length;
    await banco.pool.query("UPDATE emenda_autoria SET parlamentar_id = parlamentar_id WHERE emenda_id = $1", [e.id]);
    expect((await listarAuditoriaDaEmenda(banco.pool, e.id)).length).toBe(antes);
  });

  it('alteração direta no banco também é auditada, marcada como direto-no-banco', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    await banco.pool.query("UPDATE emenda SET objeto = 'via SQL' WHERE id = $1", [e.id]);
    const ev = await listarAuditoriaDaEmenda(banco.pool, e.id);
    const ultimo = ev[ev.length - 1]!;
    expect(ultimo).toMatchObject({ acao: 'alterar', usuario: 'desconhecido', origem: 'direto-no-banco' });
  });

  it('eventos de auditoria não podem ser editados, excluídos nem truncados', async () => {
    const e = await comTransacao(banco.pool, ctx, (c) => criarEmenda(c, nova()));
    const [primeiro] = await listarAuditoriaDaEmenda(banco.pool, e.id);
    await expect(
      banco.pool.query("UPDATE auditoria_evento SET usuario = 'fraude' WHERE id = $1", [primeiro!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(banco.pool.query('DELETE FROM auditoria_evento WHERE id = $1', [primeiro!.id])).rejects.toThrow(/append-only/);
    await expect(banco.pool.query('TRUNCATE auditoria_evento')).rejects.toThrow(/append-only/);
    const ainda = await listarAuditoriaDaEmenda(banco.pool, e.id);
    expect(ainda[0]!.usuario).toBe('maria');
  });
});
