import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consultarExecucaoDaEmenda } from '../src/modules/financeiro/consulta.js';
import { importarLote } from '../src/modules/financeiro/importador.js';
import { listarPendencias, revogarVinculo, vincularMovimento } from '../src/modules/financeiro/vinculos.js';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
let emendaA: string;
let emendaB: string;
const h = { 'x-usuario': 'paulo' };
const ctx = { usuario: 'conferente', origem: 'cli-financeiro' };
const ORIGEM = 'SIMULADO-REVISAO';

beforeAll(async () => {
  banco = await criarBancoDeTeste();
  base = await criarBase(banco.pool);
  app = appDeTeste(banco.pool);
  await app.ready();
  emendaA = await novaEmenda('EMD-A');
  emendaB = await novaEmenda('EMD-B');
});
afterAll(async () => {
  await app.close();
  await banco.encerrar();
});

async function novaEmenda(identificador: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/emendas',
    headers: h,
    payload: { exercicioId: base.exercicioId, tipo: 'individual', objeto: 'Objeto', valorPropostoCentavos: 5_000_000, autores: [base.p1] },
  });
  const id = (r.json() as { id: string }).id;
  const i = await app.inject({
    method: 'POST',
    url: `/emendas/${id}/identificadores-externos`,
    headers: h,
    payload: { sistema: ORIGEM, tipoId: 'emenda', valorId: identificador },
  });
  expect(i.statusCode).toBe(201);
  return id;
}

let contador = 0;
type Reg = Record<string, unknown>;
function lote(registros: Reg[], extra: Reg = {}) {
  contador += 1;
  return {
    formato: 'emendas-impositivas/importacao-financeira',
    versao: 1,
    origem: ORIGEM,
    exercicio: 2090,
    unidadeGestora: `UG-R${contador}`,
    dataReferencia: '2090-12-31',
    registros,
    ...extra,
  };
}
const importar = (conteudo: unknown) =>
  importarLote(banco.pool, conteudo, { usuario: 'importador', arquivoNome: 'teste.json', arquivoSha256: 'a'.repeat(64) });

const emp = (chave: string, valor: number, data = '2090-02-01', ident?: string): Reg => ({
  tipo: 'empenho', chaveOrigem: chave, dataDocumento: data, valorCentavos: valor, ...(ident ? { identificadorEmenda: ident } : {}),
});
const filho = (tipo: string, chave: string, pai: string, valor: number, data: string, ident?: string): Reg => ({
  tipo, chaveOrigem: chave, registroPaiChave: pai, dataDocumento: data, valorCentavos: valor, ...(ident ? { identificadorEmenda: ident } : {}),
});

/** Empenho + liquidação + pagamento de `valor`, todos vinculados à emenda `ident` por identificador. Devolve o lote e a UG. */
async function pagamentoDe(ident: string, p: string, valor = 100_000) {
  const c = lote([
    emp(`EMP-${p}`, valor, '2090-02-01', ident),
    filho('liquidacao', `LIQ-${p}`, `EMP-${p}`, valor, '2090-03-01', ident),
    filho('pagamento', `PAG-${p}`, `LIQ-${p}`, valor, '2090-04-01', ident),
  ]);
  const rel = await importar(c);
  expect(rel.totais.aceitas).toBe(3);
  return { ug: c.unidadeGestora, pagId: rel.linhas[2]!.movimentoId!, liqId: rel.linhas[1]!.movimentoId! };
}
const loteEstornos = (ug: string, p: string, estornos: { chave: string; valor: number; ident?: string }[]) =>
  lote(estornos.map((e, i) => filho('estorno_pagamento', e.chave, `PAG-${p}`, e.valor, `2090-05-0${i + 1}`, e.ident)), { unidadeGestora: ug });

describe('ponto 1: estorno só abate a parcela do original alocada à mesma emenda', () => {
  it('estorno com identificador de OUTRA emenda não é vinculado; fica pendência visível na emenda afetada', async () => {
    const { ug } = await pagamentoDe('EMD-A', 'X1');
    const antesA = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!.execucaoFinanceira;
    const rel = await importar(loteEstornos(ug, 'X1', [{ chave: 'EST-X1', valor: 30_000, ident: 'EMD-B' }]));
    expect(rel.linhas[0]).toMatchObject({ resultado: 'aceito', semVinculo: true }); // fato da origem é aceito, mas não alocado
    expect(rel.linhas[0]!.motivos.join(' ')).toMatch(/alocação compatível|parcela do movimento original/);

    const a = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!;
    const b = (await consultarExecucaoDaEmenda(banco.pool, emendaB))!;
    expect(a.execucaoFinanceira).toEqual(antesA); // A segue com o pagamento integral (o estorno de B não a toca)
    expect(b.execucaoFinanceira.pagoLiquidoDeEstornosCentavos).toBeGreaterThanOrEqual(0); // nunca negativo
    expect(b.execucaoFinanceira.estornoPagamentoCentavos).toBe(0);
    expect(b.pendenciasAbertas.map((p) => p.tipo)).toContain('estorno_sem_alocacao_compativel');
    // a pendência de B não revela valores nem dados de A
    expect(JSON.stringify(b.pendenciasAbertas)).not.toMatch(/EMD-A|100000/);
  });

  it('estornos parciais acumulados não passam da parcela do original alocada a ESTA emenda (rateio 60/40)', async () => {
    const { ug, pagId } = await pagamentoDe('EMD-A', 'X2');
    const v = await banco.pool.query<{ id: string }>('SELECT id FROM movimento_vinculo_emenda WHERE movimento_id = $1', [pagId]);
    await revogarVinculo(banco.pool, ctx, { vinculoId: v.rows[0]!.id, motivo: 'refazer o rateio do pagamento' });
    await vincularMovimento(banco.pool, ctx, { movimentoId: pagId, emendaId: emendaA, valorCentavos: 60_000, justificativa: 'parte A do rateio' });
    await vincularMovimento(banco.pool, ctx, { movimentoId: pagId, emendaId: emendaB, valorCentavos: 40_000, justificativa: 'parte B do rateio' });
    const rel = await importar(
      loteEstornos(ug, 'X2', [
        { chave: 'E1', valor: 40_000, ident: 'EMD-A' },
        { chave: 'E2', valor: 30_000, ident: 'EMD-A' }, // 40+30 > 60 de A (mesmo que 70 <= 100 do pagamento)
        { chave: 'E3', valor: 20_000, ident: 'EMD-A' }, // 40+20 = 60: cabe
      ]),
    );
    const porChave = (k: string) => rel.linhas.find((l) => l.chaveOrigem === k)!;
    expect(porChave('E1').semVinculo).toBe(false);
    expect(porChave('E2')).toMatchObject({ resultado: 'aceito', semVinculo: true });
    expect(porChave('E3').semVinculo).toBe(false);
    const c = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!;
    const estornosX2 = c.movimentos.filter((m) => m.registroPai?.chaveOrigem === 'PAG-X2');
    expect(estornosX2.reduce((acc, m) => acc + m.valorAlocadoNestaEmendaCentavos, 0)).toBe(60_000);
    expect(c.pendenciasAbertas.some((p) => p.chaveOrigem === 'E2' && p.tipo === 'estorno_sem_alocacao_compativel')).toBe(true);
  });

  it('vínculo manual de estorno respeita a parcela por emenda, inclusive com rateio do original', async () => {
    const { ug, pagId } = await pagamentoDe('EMD-A', 'X3');
    // reparte o pagamento: libera 40 de A e atribui 40 a B (A: 60, B: 40)
    const mov = await banco.pool.query<{ id: string }>("SELECT id FROM movimento_vinculo_emenda WHERE movimento_id = $1", [pagId]);
    await revogarVinculo(banco.pool, ctx, { vinculoId: mov.rows[0]!.id, motivo: 'refazer o rateio do pagamento' });
    await vincularMovimento(banco.pool, ctx, { movimentoId: pagId, emendaId: emendaA, valorCentavos: 60_000, justificativa: 'parte A do rateio' });
    await vincularMovimento(banco.pool, ctx, { movimentoId: pagId, emendaId: emendaB, valorCentavos: 40_000, justificativa: 'parte B do rateio' });

    const rel = await importar(loteEstornos(ug, 'X3', [{ chave: 'EST-X3', valor: 70_000 }]));
    const est = rel.linhas[0]!.movimentoId!;
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId: est, emendaId: emendaA, valorCentavos: 61_000, justificativa: 'acima da parcela de A' })).rejects.toThrow(/parcela/);
    await vincularMovimento(banco.pool, ctx, { movimentoId: est, emendaId: emendaA, valorCentavos: 60_000, justificativa: 'parte A do estorno' });
    await vincularMovimento(banco.pool, ctx, { movimentoId: est, emendaId: emendaB, valorCentavos: 10_000, justificativa: 'parte B do estorno' });
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId: est, emendaId: emendaB, valorCentavos: 31_000, justificativa: 'acima da parcela de B' })).rejects.toThrow();
    for (const e of [emendaA, emendaB]) {
      expect((await consultarExecucaoDaEmenda(banco.pool, e))!.execucaoFinanceira.pagoLiquidoDeEstornosCentavos).toBeGreaterThanOrEqual(0);
    }
  });

  it('o banco recusa estorno em emenda sem parcela do original, mesmo fora do importador', async () => {
    const { ug } = await pagamentoDe('EMD-A', 'X4');
    const rel = await importar(loteEstornos(ug, 'X4', [{ chave: 'EST-X4', valor: 10_000 }]));
    await expect(
      banco.pool.query(
        `INSERT INTO movimento_vinculo_emenda (movimento_id, emenda_id, valor_centavos, decisao, justificativa, decidido_por)
         VALUES ($1,$2,10000,'manual','direto no banco','x')`,
        [rel.linhas[0]!.movimentoId, emendaB],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('revogar o vínculo do original que já tem estornos vinculados à mesma emenda é bloqueado; revogando o estorno antes, passa', async () => {
    const { ug, pagId } = await pagamentoDe('EMD-A', 'X5');
    const rel = await importar(loteEstornos(ug, 'X5', [{ chave: 'EST-X5', valor: 20_000, ident: 'EMD-A' }]));
    expect(rel.linhas[0]!.semVinculo).toBe(false);
    const vOriginal = (await banco.pool.query<{ id: string }>('SELECT id FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL', [pagId])).rows[0]!.id;
    await expect(revogarVinculo(banco.pool, ctx, { vinculoId: vOriginal, motivo: 'tentativa indevida' })).rejects.toThrow(/estornos/);
    const vEstorno = (await banco.pool.query<{ id: string }>('SELECT id FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL', [rel.linhas[0]!.movimentoId]))
      .rows[0]!.id;
    await revogarVinculo(banco.pool, ctx, { vinculoId: vEstorno, motivo: 'desfazer estorno primeiro' });
    await revogarVinculo(banco.pool, ctx, { vinculoId: vOriginal, motivo: 'agora sem estornos' });
  });

  it('pendência de estorno sem alocação compatível se resolve ao vincular o estorno à emenda certa', async () => {
    const { ug } = await pagamentoDe('EMD-A', 'X6');
    const rel = await importar(loteEstornos(ug, 'X6', [{ chave: 'EST-X6', valor: 5_000, ident: 'EMD-B' }]));
    const est = rel.linhas[0]!.movimentoId!;
    const antes = (await listarPendencias(banco.pool)).filter((p) => p.movimentoId === est);
    expect(antes.map((p) => p.tipo)).toEqual(['estorno_sem_alocacao_compativel']);
    const v = await vincularMovimento(banco.pool, ctx, { movimentoId: est, emendaId: emendaA, justificativa: 'estorno pertence à emenda A' });
    expect(v.pendenciaSemVinculoResolvida).toBe(true);
    expect((await listarPendencias(banco.pool)).some((p) => p.movimentoId === est)).toBe(false);
    expect((await consultarExecucaoDaEmenda(banco.pool, emendaB))!.pendenciasAbertas.some((p) => p.movimentoId === est)).toBe(false);
  });

  it('concorrência: dois estornos que somariam mais que a parcela — só um é vinculado; e revogar o original x vincular estorno nunca deixa estorno órfão', async () => {
    for (let i = 0; i < 5; i += 1) {
      const p = `C${i}`;
      const { ug, pagId } = await pagamentoDe('EMD-A', p);
      const rel = await importar(
        loteEstornos(ug, p, [
          { chave: `E1-${p}`, valor: 60_000 },
          { chave: `E2-${p}`, valor: 60_000 },
        ]),
      );
      const [m1, m2] = rel.linhas.map((l) => l.movimentoId!);
      const r = await Promise.allSettled([
        vincularMovimento(banco.pool, ctx, { movimentoId: m1!, emendaId: emendaA, justificativa: 'paralelo 1' }),
        vincularMovimento(banco.pool, ctx, { movimentoId: m2!, emendaId: emendaA, justificativa: 'paralelo 2' }),
      ]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);

      // agora: revogar o original em paralelo com um vínculo de estorno de outro pagamento
      const q = `D${i}`;
      const seg = await pagamentoDe('EMD-A', q);
      const relq = await importar(loteEstornos(seg.ug, q, [{ chave: `E1-${q}`, valor: 10_000 }]));
      const vOrig = (await banco.pool.query<{ id: string }>('SELECT id FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL', [seg.pagId])).rows[0]!.id;
      await Promise.allSettled([
        revogarVinculo(banco.pool, ctx, { vinculoId: vOrig, motivo: 'concorrente com o vínculo do estorno' }),
        vincularMovimento(banco.pool, ctx, { movimentoId: relq.linhas[0]!.movimentoId!, emendaId: emendaA, justificativa: 'concorrente com a revogação' }),
      ]);
      const orfaos = await banco.pool.query(
        `SELECT 1 FROM movimento_vinculo_emenda ve
           JOIN movimento_financeiro f ON f.id = ve.movimento_id AND f.tipo LIKE 'estorno_%'
          WHERE ve.revogado_em IS NULL
            AND (coalesce((SELECT sum(o.valor_centavos) FROM movimento_vinculo_emenda o WHERE o.movimento_id = f.registro_pai_id AND o.emenda_id = ve.emenda_id AND o.revogado_em IS NULL), 0)
                 < (SELECT sum(s.valor_centavos) FROM movimento_vinculo_emenda s JOIN movimento_financeiro sf ON sf.id = s.movimento_id
                     WHERE sf.registro_pai_id = f.registro_pai_id AND s.emenda_id = ve.emenda_id AND s.revogado_em IS NULL))`,
      );
      expect(orfaos.rowCount).toBe(0);
      expect(pagId).toBeTruthy();
    }
  });
});

describe('ponto 2: ordem do lote — estorno válido libera saldo para reposição no mesmo lote', () => {
  const cenario = (ordem: 'repos-antes' | 'estorno-antes'): Reg[] => {
    const l1 = filho('liquidacao', 'L1', 'EMP', 100_000, '2090-03-01', 'EMD-A');
    const est = filho('estorno_liquidacao', 'ELIQ', 'L1', 40_000, '2090-03-10', 'EMD-A');
    const l2 = filho('liquidacao', 'L2', 'EMP', 40_000, '2090-03-11', 'EMD-A');
    return ordem === 'repos-antes' ? [emp('EMP', 100_000, '2090-02-01', 'EMD-A'), l1, l2, est] : [emp('EMP', 100_000, '2090-02-01', 'EMD-A'), l1, est, l2];
  };

  it('empenho todo consumido + estorno + liquidação substituta: tudo aceito, em qualquer ordem do arquivo', async () => {
    for (const ordem of ['repos-antes', 'estorno-antes'] as const) {
      const rel = await importar(lote(cenario(ordem)));
      expect(rel.totais, ordem).toMatchObject({ aceitas: 4, rejeitadas: 0 });
    }
  });

  it('sem o estorno, a reposição continua rejeitada por falta de saldo (não há saldo inventado)', async () => {
    const rel = await importar(lote(cenario('repos-antes').filter((r) => r.chaveOrigem !== 'ELIQ')));
    expect(rel.linhas.find((l) => l.chaveOrigem === 'L2')).toMatchObject({ resultado: 'rejeitado' });
    expect(rel.linhas.find((l) => l.chaveOrigem === 'L2')!.motivos.join(' ')).toMatch(/excede o saldo do empenho/);
  });

  it('o estorno que libera saldo precisa ser válido: estorno acima do original não libera nada', async () => {
    const regs = cenario('repos-antes').map((r) => (r.chaveOrigem === 'ELIQ' ? { ...r, valorCentavos: 100_001 } : r));
    const rel = await importar(lote(regs));
    expect(rel.linhas.find((l) => l.chaveOrigem === 'ELIQ')!.resultado).toBe('rejeitado');
    expect(rel.linhas.find((l) => l.chaveOrigem === 'L2')!.resultado).toBe('rejeitado');
  });

  it('pai e filho com a mesma data, filho listado primeiro: dependência é respeitada', async () => {
    const rel = await importar(lote([filho('liquidacao', 'LF', 'EF', 100, '2090-02-01', 'EMD-A'), emp('EF', 100, '2090-02-01', 'EMD-A')]));
    expect(rel.totais).toMatchObject({ aceitas: 2, rejeitadas: 0 });
  });

  it('disputa pelo mesmo saldo: vale a de menor (data, posição); a outra é rejeitada com motivo, sem inventar cronologia', async () => {
    const regs = [
      emp('DP-EMP', 100_000, '2090-02-01', 'EMD-A'),
      filho('liquidacao', 'DP-B', 'DP-EMP', 70_000, '2090-03-02', 'EMD-A'),
      filho('liquidacao', 'DP-A', 'DP-EMP', 60_000, '2090-03-01', 'EMD-A'),
    ];
    const rel = await importar(lote(regs));
    expect(rel.linhas.find((l) => l.chaveOrigem === 'DP-A')!.resultado).toBe('aceito'); // data menor
    expect(rel.linhas.find((l) => l.chaveOrigem === 'DP-B')!.resultado).toBe('rejeitado');
    // mesmo resultado se o arquivo vier em outra ordem
    const rel2 = await importar(lote([...regs].reverse()));
    expect(rel2.linhas.filter((l) => l.resultado === 'aceito').map((l) => l.chaveOrigem).sort()).toEqual(['DP-A', 'DP-EMP']);
  });
});

describe('ponto 3: data do movimento x referência do lote antes de classificar como já importado', () => {
  it('movimento de julho repetido em lote com referência de junho é rejeitado, não "ja_importado"', async () => {
    const ug = `UG-REF-${++contador}`;
    const julho = lote([emp('REF-1', 5_000, '2090-07-15', 'EMD-A')], { unidadeGestora: ug, dataReferencia: '2090-07-31' });
    expect((await importar(julho)).totais.aceitas).toBe(1);
    const junho = lote([emp('REF-1', 5_000, '2090-07-15', 'EMD-A')], { unidadeGestora: ug, dataReferencia: '2090-06-30' });
    const rel = await importar(junho);
    expect(rel.linhas[0]!.resultado).toBe('rejeitado');
    expect(rel.linhas[0]!.motivos.join(' ')).toMatch(/posterior à data de referência/);
    // idem para conteúdo divergente: a checagem de data vem antes da divergência
    const junhoDiv = lote([emp('REF-1', 6_000, '2090-07-15', 'EMD-A')], { unidadeGestora: ug, dataReferencia: '2090-06-30' });
    expect((await importar(junhoDiv)).linhas[0]!.resultado).toBe('rejeitado');
    expect((await listarPendencias(banco.pool)).some((p) => p.tipo === 'divergencia_origem' && p.chaveOrigem === 'REF-1')).toBe(false);
  });

  it('a consulta separa a data da última carga da referência mais recente dos dados', async () => {
    const emendaC = await novaEmenda('EMD-C');
    const ug = `UG-REF-${++contador}`;
    const julho = lote([emp('REF-2', 7_000, '2090-07-01', 'EMD-C'), emp('REF-3', 1_000, '2090-02-01', 'EMD-C')], { unidadeGestora: ug, dataReferencia: '2090-07-31' });
    await importar(julho);
    const historica = lote([emp('REF-3', 1_000, '2090-02-01', 'EMD-C')], { unidadeGestora: ug, dataReferencia: '2090-06-30' });
    const rel = await importar(historica);
    expect(rel.linhas[0]!.resultado).toBe('ja_importado');
    const c = (await consultarExecucaoDaEmenda(banco.pool, emendaC))!;
    expect(c.ultimaImportacao).toMatchObject({ loteId: rel.loteId, dataReferencia: '2090-06-30' }); // última carga
    expect(c.referenciaMaisRecenteDosDados).toBe('2090-07-31'); // nunca retrocede para junho
    expect(c.ultimaImportacao!.importadoEm).toBeTruthy();
  });
});
