import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executarMigracoes } from '../src/db/migrar.js';
import { semearDesenvolvimento } from '../src/db/seed-dev.js';
import { criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let base: Awaited<ReturnType<typeof criarBase>>;

beforeAll(async () => {
  banco = await criarBancoDeTeste();
  base = await criarBase(banco.pool);
});
afterAll(async () => banco.encerrar());

async function inserirEmenda(over: Record<string, unknown> = {}) {
  const v = {
    exercicio_id: base.exercicioId,
    numero_oficial: null,
    tipo: 'individual',
    objeto: 'Objeto de teste',
    valor: 100,
    ...over,
  };
  return banco.pool.query<{ id: string }>(
    `INSERT INTO emenda (exercicio_id, numero_oficial, tipo, objeto, valor_proposto_centavos)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [v.exercicio_id, v.numero_oficial, v.tipo, v.objeto, v.valor],
  );
}

describe('migrações', () => {
  it('são idempotentes: segunda execução não reaplica', async () => {
    const r = await executarMigracoes(banco.pool);
    expect(r.aplicadas).toEqual([]);
    expect(r.jaAplicadas.length).toBeGreaterThan(0);
  });

  it('detectam edição de migração já aplicada', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(pasta, '0001_x.sql'), 'SELECT 1;');
    await executarMigracoes(banco.pool, pasta);
    await writeFile(join(pasta, '0001_x.sql'), 'SELECT 2;');
    await expect(executarMigracoes(banco.pool, pasta)).rejects.toThrow(/alterada após ser aplicada/);
  });

  it('migração com erro faz rollback completo', async () => {
    const pasta = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(pasta, '0099_ruim.sql'), 'CREATE TABLE tmp_ruim (a int); SELECT 1/0;');
    await expect(executarMigracoes(banco.pool, pasta)).rejects.toThrow(/Falha na migração/);
    const r = await banco.pool.query("SELECT to_regclass('tmp_ruim') AS t");
    expect(r.rows[0].t).toBeNull();
  });
});

describe('integridade da emenda', () => {
  it('gera id interno e preserva valor em centavos exatos', async () => {
    const grande = '9007199254740991';
    const r = await inserirEmenda({ valor: grande });
    const lido = await banco.pool.query('SELECT valor_proposto_centavos FROM emenda WHERE id = $1', [r.rows[0]!.id]);
    expect(lido.rows[0].valor_proposto_centavos).toBe(grande);
  });

  it('rejeita valor negativo, tipo inválido, objeto vazio e exercício inexistente', async () => {
    await expect(inserirEmenda({ valor: -1 })).rejects.toMatchObject({ code: '23514' });
    await expect(inserirEmenda({ tipo: 'outro' })).rejects.toMatchObject({ code: '23514' });
    await expect(inserirEmenda({ objeto: '   ' })).rejects.toMatchObject({ code: '23514' });
    await expect(
      inserirEmenda({ exercicio_id: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('número oficial é único por exercício, mas vários podem ficar sem número', async () => {
    await inserirEmenda({ numero_oficial: 'N-1' });
    await expect(inserirEmenda({ numero_oficial: 'N-1' })).rejects.toMatchObject({ code: '23505' });
    await inserirEmenda();
    await inserirEmenda();
  });

  it('id é imutável e emenda não pode ser excluída fisicamente', async () => {
    const { id } = (await inserirEmenda()).rows[0]!;
    await expect(
      banco.pool.query("UPDATE emenda SET id = '11111111-1111-1111-1111-111111111111' WHERE id = $1", [id]),
    ).rejects.toThrow(/imutável/);
    await expect(banco.pool.query('DELETE FROM emenda WHERE id = $1', [id])).rejects.toThrow(/não pode ser excluída/);
  });

  it('versão e atualizado_em avançam a cada alteração', async () => {
    const { id } = (await inserirEmenda()).rows[0]!;
    await banco.pool.query("UPDATE emenda SET objeto = 'novo' WHERE id = $1", [id]);
    const r = await banco.pool.query('SELECT versao FROM emenda WHERE id = $1', [id]);
    expect(r.rows[0].versao).toBe(2);
  });

  it('autoria: sem duplicar parlamentar na mesma emenda e com referências válidas', async () => {
    const { id } = (await inserirEmenda()).rows[0]!;
    await banco.pool.query('INSERT INTO emenda_autoria (emenda_id, parlamentar_id) VALUES ($1,$2)', [id, base.p1]);
    await banco.pool.query('INSERT INTO emenda_autoria (emenda_id, parlamentar_id) VALUES ($1,$2)', [id, base.p2]);
    await expect(
      banco.pool.query('INSERT INTO emenda_autoria (emenda_id, parlamentar_id) VALUES ($1,$2)', [id, base.p1]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      banco.pool.query('INSERT INTO emenda_autoria (emenda_id, parlamentar_id) VALUES ($1,$2)', [
        id,
        '00000000-0000-0000-0000-000000000000',
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('identificador externo é separado do id e único por sistema/tipo/valor', async () => {
    const a = (await inserirEmenda()).rows[0]!.id;
    const b = (await inserirEmenda()).rows[0]!.id;
    const ins = (e: string) =>
      banco.pool.query(
        "INSERT INTO emenda_identificador_externo (emenda_id, sistema, tipo_id, valor_id) VALUES ($1,'ipm','emenda','X1')",
        [e],
      );
    await ins(a);
    await expect(ins(b)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('dados fictícios de desenvolvimento', () => {
  it('são idempotentes e claramente marcados como fictícios', async () => {
    const outro = await criarBancoDeTeste();
    try {
      expect((await semearDesenvolvimento(outro.pool)).criado).toBe(true);
      expect((await semearDesenvolvimento(outro.pool)).criado).toBe(false);
      const r = await outro.pool.query('SELECT objeto FROM emenda');
      expect(r.rowCount).toBe(3);
      expect(r.rows.every((x) => String(x.objeto).startsWith('[FICTÍCIO]'))).toBe(true);
    } finally {
      await outro.encerrar();
    }
  });
});
