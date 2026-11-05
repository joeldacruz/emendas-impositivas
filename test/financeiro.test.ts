import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErroFormato } from '../src/modules/financeiro/formato.js';
import { consultarExecucaoDaEmenda } from '../src/modules/financeiro/consulta.js';
import { importarLote } from '../src/modules/financeiro/importador.js';
import {
  listarMovimentos,
  listarPendencias,
  resolverPendenciaDeDivergencia,
  revogarVinculo,
  vincularMovimento,
} from '../src/modules/financeiro/vinculos.js';
import { appDeTeste, criarBancoDeTeste, criarBase, type BancoDeTeste } from './ajuda.js';

let banco: BancoDeTeste;
let app: FastifyInstance;
let base: Awaited<ReturnType<typeof criarBase>>;
let emendaA: string;
let emendaB: string;
const h = { 'x-usuario': 'paulo' };
const ctx = { usuario: 'conferente', origem: 'cli-financeiro' };
const ORIGEM = 'SIMULADO-TESTE';

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

async function novaEmenda(identificador: string, valor = 5_000_000) {
  const r = await app.inject({
    method: 'POST',
    url: '/emendas',
    headers: h,
    payload: { exercicioId: base.exercicioId, tipo: 'individual', objeto: 'Objeto', valorPropostoCentavos: valor, autores: [base.p1] },
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
const novaUg = () => `UG-T${++contador}`;

type Reg = Record<string, unknown>;
function lote(registros: Reg[], extra: Reg = {}) {
  return {
    formato: 'emendas-impositivas/importacao-financeira',
    versao: 1,
    origem: ORIGEM,
    exercicio: 2090,
    unidadeGestora: novaUg(),
    dataReferencia: '2090-12-31',
    registros,
    ...extra,
  };
}
const importar = (conteudo: unknown, extra: { somenteValidar?: boolean } = {}) =>
  importarLote(banco.pool, conteudo, { usuario: 'importador', arquivoNome: 'teste.json', arquivoSha256: 'a'.repeat(64), ...extra });

const emp = (chave: string, valor: number, ident?: string, extra: Reg = {}): Reg => ({
  tipo: 'empenho', chaveOrigem: chave, dataDocumento: '2090-02-10', valorCentavos: valor, ...(ident ? { identificadorEmenda: ident } : {}), ...extra,
});
const filho = (tipo: string, chave: string, pai: string, valor: number, data: string, ident?: string): Reg => ({
  tipo, chaveOrigem: chave, registroPaiChave: pai, dataDocumento: data, valorCentavos: valor, ...(ident ? { identificadorEmenda: ident } : {}),
});

/** Cadeia completa: empenho 6000, liquidação 4000, pagamento 2500, estorno de pagamento 500, estorno de liquidação 1000 (em reais x 100). */
const cadeia = (ident: string, p = ''): Reg[] => [
  emp(`EMP${p}`, 600_000, ident),
  filho('liquidacao', `LIQ${p}`, `EMP${p}`, 400_000, '2090-03-05', ident),
  filho('pagamento', `PAG${p}`, `LIQ${p}`, 250_000, '2090-03-20', ident),
  filho('estorno_pagamento', `EPAG${p}`, `PAG${p}`, 50_000, '2090-04-02', ident),
  filho('estorno_liquidacao', `ELIQ${p}`, `LIQ${p}`, 100_000, '2090-04-10', ident),
];

const contar = async (tabela: string) => Number((await banco.pool.query(`SELECT count(*) FROM ${tabela}`)).rows[0].count);
const somaMov = async () => String((await banco.pool.query('SELECT coalesce(sum(valor_centavos),0) AS s FROM movimento_financeiro')).rows[0].s);

describe('importação: lote com empenho, liquidação, pagamento e estorno', () => {
  it('consolida o lote, vincula pelo identificador e a consulta separa empenhado, liquidado, pago e estornos', async () => {
    const rel = await importar(lote(cadeia('EMD-A')));
    expect(rel.totais).toEqual({ linhas: 5, aceitas: 5, jaImportadas: 0, divergentes: 0, rejeitadas: 0, semVinculo: 0 });
    expect(rel.linhas.every((l) => l.resultado === 'aceito' && !l.semVinculo)).toBe(true);

    const c = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!;
    expect(c.execucaoFinanceira).toEqual({
      empenhadoCentavos: 600_000,
      liquidadoCentavos: 400_000,
      pagoCentavos: 250_000,
      estornoLiquidacaoCentavos: 100_000,
      estornoPagamentoCentavos: 50_000,
      liquidadoLiquidoDeEstornosCentavos: 300_000,
      pagoLiquidoDeEstornosCentavos: 200_000,
    });
    expect(c.ultimaImportacao).toMatchObject({ loteId: rel.loteId, dataReferencia: '2090-12-31' });
    expect(c.movimentos.map((m) => m.tipo)).toEqual(['empenho', 'liquidacao', 'pagamento', 'estorno_pagamento', 'estorno_liquidacao']);
    expect(c.movimentos.find((m) => m.tipo === 'liquidacao')!.registroPai).toEqual({ chaveOrigem: 'EMP', tipo: 'empenho' });
    expect(c.movimentos.find((m) => m.tipo === 'estorno_pagamento')!.decisaoDeVinculo).toMatchObject({ tipo: 'identificador_externo', por: 'importador' });
    // estados distintos: não se infere entrega nem prestação de contas
    expect(c.naoApurado.objetoEntregue).toBeNull();
    expect(c.naoApurado.prestacaoDeContasAprovada).toBeNull();
    expect(JSON.stringify(c)).not.toMatch(/credor/i);
  });

  it('a ordem do arquivo não importa: o filho pode vir antes do pai', async () => {
    const ug = novaUg();
    const regs = cadeia('EMD-A', 'ORD').reverse();
    const rel = await importar(lote(regs, { unidadeGestora: ug }));
    expect(rel.totais.aceitas).toBe(5);
    expect(rel.linhas.map((l) => l.numeroLinha)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('idempotência', () => {
  it('reimportar o mesmo lote não duplica movimentos, vínculos nem totais', async () => {
    const conteudo = lote(cadeia('EMD-B', 'IDEM'));
    const primeira = await importar(conteudo);
    expect(primeira.totais.aceitas).toBe(5);
    const mov = await contar('movimento_financeiro');
    const vin = await contar('movimento_vinculo_emenda');
    const soma = await somaMov();
    const antes = (await consultarExecucaoDaEmenda(banco.pool, emendaB))!;

    const segunda = await importar(conteudo);
    expect(segunda.totais).toEqual({ linhas: 5, aceitas: 0, jaImportadas: 5, divergentes: 0, rejeitadas: 0, semVinculo: 0 });
    expect(segunda.loteId).not.toBe(primeira.loteId); // a tentativa fica registrada como lote próprio
    expect(await contar('movimento_financeiro')).toBe(mov);
    expect(await contar('movimento_vinculo_emenda')).toBe(vin);
    expect(await somaMov()).toBe(soma);
    const depois = (await consultarExecucaoDaEmenda(banco.pool, emendaB))!;
    expect(depois.execucaoFinanceira).toEqual(antes.execucaoFinanceira);
    expect(depois.ultimaImportacao!.loteId).toBe(segunda.loteId); // data da última importação avança
  });

  it('a mesma chave em unidade gestora ou exercício diferente é outro movimento (escopo da chave)', async () => {
    const ex2 = await banco.pool.query<{ id: string }>('INSERT INTO exercicio (ano) VALUES (2091) RETURNING id');
    expect(ex2.rowCount).toBe(1);
    const r1 = await importar(lote([emp('MESMA-CHAVE', 1000)], { unidadeGestora: 'UG-X' }));
    const r2 = await importar(lote([emp('MESMA-CHAVE', 2000)], { unidadeGestora: 'UG-Y' }));
    const r3 = await importar(lote([emp('MESMA-CHAVE', 3000)], { unidadeGestora: 'UG-X', exercicio: 2091 }));
    for (const r of [r1, r2, r3]) expect(r.linhas[0]!.resultado).toBe('aceito'); // nenhuma divergência: escopos distintos
    const n = await banco.pool.query("SELECT count(*)::int AS n FROM movimento_financeiro WHERE chave_origem = 'MESMA-CHAVE'");
    expect(n.rows[0].n).toBe(3);
  });
});

describe('registro inválido, rejeições e pendências rastreáveis', () => {
  it('rejeita registros inválidos com o motivo, sem impedir os válidos', async () => {
    const rel = await importar(
      lote([
        emp('OK-1', 1000, 'EMD-A'),
        { tipo: 'empenho', chaveOrigem: 'RUIM-1', dataDocumento: '2090-13-45', valorCentavos: 12.5 },
        { tipo: 'abracadabra', chaveOrigem: 'RUIM-2', dataDocumento: '2090-01-01', valorCentavos: 100 },
        { tipo: 'liquidacao', chaveOrigem: 'RUIM-3', dataDocumento: '2090-01-01', valorCentavos: 100 }, // sem pai
        { tipo: 'empenho', chaveOrigem: 'RUIM-4', dataDocumento: '2090-01-01', valorCentavos: 100, campoDesconhecido: 1 },
        filho('liquidacao', 'RUIM-5', 'NAO-EXISTE', 100, '2090-03-01'),
        emp('RUIM-6', 100, undefined, { dataDocumento: '2091-01-01' }), // depois da data de referência
        'não sou objeto' as unknown as Reg,
      ]),
    );
    expect(rel.totais).toMatchObject({ linhas: 8, aceitas: 1, rejeitadas: 7 });
    const porChave = (k: string) => rel.linhas.find((l) => l.chaveOrigem === k)!;
    expect(porChave('RUIM-1').motivos.join(' ')).toMatch(/dataDocumento.*data inválida|valorCentavos.*inteiro/);
    expect(porChave('RUIM-2').motivos.join(' ')).toMatch(/tipo deve ser um de/);
    expect(porChave('RUIM-3').motivos.join(' ')).toMatch(/exige o registro pai/);
    expect(porChave('RUIM-4').motivos.join(' ')).toMatch(/campoDesconhecido|Unrecognized/i);
    expect(porChave('RUIM-5').motivos.join(' ')).toMatch(/não encontrado/);
    expect(porChave('RUIM-6').motivos.join(' ')).toMatch(/posterior à data de referência/);
    expect(rel.linhas[7]!.motivos).toEqual(['registro deve ser um objeto']);
    // o resultado por linha fica gravado e é consultável
    const gravadas = await banco.pool.query('SELECT resultado, motivos FROM importacao_linha WHERE lote_id = $1 ORDER BY numero_linha', [rel.loteId]);
    expect(gravadas.rows.map((r) => r.resultado)).toEqual(['aceito', ...Array(7).fill('rejeitado')]);
    expect(gravadas.rows[1].motivos.length).toBeGreaterThan(0);
    expect(await contar('movimento_financeiro')).toBeGreaterThan(0);
    const rejeitadosGravados = await banco.pool.query("SELECT count(*)::int AS n FROM movimento_financeiro WHERE chave_origem LIKE 'RUIM-%'");
    expect(rejeitadosGravados.rows[0].n).toBe(0);
  });

  it('cabeçalho inválido recusa o lote inteiro e não grava nada; origem não simulada é recusada', async () => {
    const lotes = await contar('importacao_lote');
    await expect(importar(lote([], { origem: 'IPM-REAL' }))).rejects.toBeInstanceOf(ErroFormato);
    await expect(importar(lote([], { versao: 2 }))).rejects.toBeInstanceOf(ErroFormato);
    await expect(importar(lote([], { exercicio: 2080 }))).rejects.toThrow(/não está cadastrado/);
    await expect(importar({ qualquer: 'coisa' })).rejects.toBeInstanceOf(ErroFormato);
    expect(await contar('importacao_lote')).toBe(lotes);
    // defesa também no banco
    await expect(
      banco.pool.query(
        `INSERT INTO importacao_lote (origem, exercicio_id, unidade_gestora, data_referencia, formato_versao, arquivo_sha256, importado_por)
         VALUES ('IPM-REAL', $1, 'x', '2090-01-01', 1, $2, 'x')`,
        [base.exercicioId, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('regras de saldo da cadeia: liquidação, pagamento e estornos não passam do que existe', async () => {
    const rel = await importar(
      lote([
        emp('S-EMP', 100_000, 'EMD-A'),
        filho('liquidacao', 'S-LIQ-1', 'S-EMP', 70_000, '2090-03-01', 'EMD-A'),
        filho('liquidacao', 'S-LIQ-2', 'S-EMP', 40_000, '2090-03-02', 'EMD-A'), // 110.000 > 100.000
        filho('pagamento', 'S-PAG-1', 'S-LIQ-1', 70_001, '2090-03-03', 'EMD-A'), // > liquidação
        filho('pagamento', 'S-PAG-2', 'S-LIQ-1', 50_000, '2090-03-03', 'EMD-A'),
        filho('estorno_pagamento', 'S-EPAG-1', 'S-PAG-2', 50_001, '2090-03-04', 'EMD-A'), // > pagamento
        filho('estorno_liquidacao', 'S-ELIQ-1', 'S-LIQ-1', 30_000, '2090-03-05', 'EMD-A'), // deixaria 40.000 < pago 50.000
        filho('liquidacao', 'S-LIQ-ANTES', 'S-EMP', 10, '2089-12-31', 'EMD-A'), // antes do empenho
      ]),
    );
    const r = (k: string) => rel.linhas.find((l) => l.chaveOrigem === k)!;
    expect(r('S-LIQ-1').resultado).toBe('aceito');
    expect(r('S-PAG-2').resultado).toBe('aceito');
    expect(r('S-LIQ-2').motivos.join(' ')).toMatch(/excede o saldo do empenho/);
    expect(r('S-PAG-1').motivos.join(' ')).toMatch(/excede o saldo da liquidação/);
    expect(r('S-EPAG-1').motivos.join(' ')).toMatch(/excede o valor do pagamento/);
    expect(r('S-ELIQ-1').motivos.join(' ')).toMatch(/abaixo do já pago/);
    expect(r('S-LIQ-ANTES').motivos.join(' ')).toMatch(/anterior à do registro pai/);
  });
});

describe('divergência na origem', () => {
  it('preserva o registro anterior e abre pendência; o mesmo conteúdo divergente não duplica a pendência', async () => {
    const ug = novaUg();
    const original = lote([emp('DIV-1', 100_000, 'EMD-A')], { unidadeGestora: ug });
    await importar(original);
    const divergente = lote([emp('DIV-1', 120_000, 'EMD-A')], { unidadeGestora: ug, dataReferencia: '2090-12-31' });
    const rel = await importar(divergente);
    expect(rel.totais).toMatchObject({ divergentes: 1, aceitas: 0 });
    const linha = rel.linhas[0]!;
    expect(linha.resultado).toBe('divergente');
    expect(linha.motivos.join(' ')).toMatch(/valorCentavos: 100000 -> 120000/);
    expect(linha.pendenciaId).toBeTruthy();

    const m = await banco.pool.query("SELECT valor_centavos::text AS v FROM movimento_financeiro WHERE id = $1", [linha.movimentoId]);
    expect(m.rows[0].v).toBe('100000'); // anterior preservado

    const abertas = (await listarPendencias(banco.pool)).filter((p) => p.tipo === 'divergencia_origem' && p.movimentoId === linha.movimentoId);
    expect(abertas).toHaveLength(1);
    expect(abertas[0]!.detalhes).toMatchObject({ camposDivergentes: ['valorCentavos'], recebido: { valorCentavos: 120_000 }, anterior: { valorCentavos: 100_000 } });

    // reenvio do mesmo conteúdo divergente: continua divergente, sem pendência nova
    const de_novo = await importar(divergente);
    expect(de_novo.linhas[0]!.pendenciaId).toBe(linha.pendenciaId);
    expect(de_novo.linhas[0]!.motivos.join(' ')).toMatch(/nenhuma pendência nova/);
    const todas = (await listarPendencias(banco.pool, { todas: true })).filter((p) => p.tipo === 'divergencia_origem' && p.movimentoId === linha.movimentoId);
    expect(todas).toHaveLength(1);

    // conferência humana encerra a pendência sem mudar o movimento; não pode ser resolvida duas vezes
    await expect(resolverPendenciaDeDivergencia(banco.pool, ctx, { pendenciaId: linha.pendenciaId!, resolucao: 'x' })).rejects.toThrow(/mínimo 3/);
    await resolverPendenciaDeDivergencia(banco.pool, ctx, { pendenciaId: linha.pendenciaId!, resolucao: 'Conferido na contabilidade: vale o valor anterior' });
    expect((await listarPendencias(banco.pool)).some((p) => p.id === linha.pendenciaId)).toBe(false);
    await expect(
      resolverPendenciaDeDivergencia(banco.pool, ctx, { pendenciaId: linha.pendenciaId!, resolucao: 'outra vez' }),
    ).rejects.toThrow();
    const m2 = await banco.pool.query('SELECT valor_centavos::text AS v FROM movimento_financeiro WHERE id = $1', [linha.movimentoId]);
    expect(m2.rows[0].v).toBe('100000');
  });
});

describe('movimento sem vínculo e vínculo manual', () => {
  it('não deduz vínculo: sem identificador, identificador desconhecido ou de outro exercício ficam pendentes', async () => {
    const ug = novaUg();
    // emenda de outro exercício com identificador conhecido
    await banco.pool.query("INSERT INTO exercicio (ano) VALUES (2092) ON CONFLICT DO NOTHING");
    const ex = await banco.pool.query<{ id: string }>('SELECT id FROM exercicio WHERE ano = 2092');
    const outra = await app.inject({
      method: 'POST', url: '/emendas', headers: h,
      payload: { exercicioId: ex.rows[0]!.id, tipo: 'individual', objeto: 'Outro exercício', valorPropostoCentavos: 1_000_000, autores: [base.p1] },
    });
    await app.inject({
      method: 'POST', url: `/emendas/${(outra.json() as { id: string }).id}/identificadores-externos`, headers: h,
      payload: { sistema: ORIGEM, tipoId: 'emenda', valorId: 'EMD-OUTRO-EXERCICIO' },
    });
    const antesA = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!.execucaoFinanceira;
    const rel = await importar(
      lote(
        [
          emp('SV-1', 55_000, undefined, { credorNome: '[FICTÍCIO] mesmo credor da emenda A' }),
          emp('SV-2', 66_000, 'EMD-NAO-CADASTRADO'),
          emp('SV-3', 77_000, 'EMD-OUTRO-EXERCICIO'),
        ],
        { unidadeGestora: ug },
      ),
    );
    expect(rel.totais).toMatchObject({ aceitas: 3, semVinculo: 3 });
    expect(rel.linhas.map((l) => l.semVinculo)).toEqual([true, true, true]);
    expect(rel.linhas[0]!.motivos[0]).toMatch(/sem identificadorEmenda/);
    expect(rel.linhas[1]!.motivos[0]).toMatch(/não está cadastrado/);
    expect(rel.linhas[2]!.motivos[0]).toMatch(/outro exercício/);
    const pendentes = (await listarPendencias(banco.pool)).filter((p) => p.tipo === 'sem_vinculo' && p.unidadeGestora === ug);
    expect(pendentes).toHaveLength(3);
    expect((await listarMovimentos(banco.pool, { semVinculo: true })).filter((m) => m.unidadeGestora === ug)).toHaveLength(3);
    // nada vazou para a emenda A
    expect((await consultarExecucaoDaEmenda(banco.pool, emendaA))!.execucaoFinanceira).toEqual(antesA);
  });

  it('vínculo manual exige justificativa, resolve a pendência, aparece na auditoria da emenda e pode ser revogado', async () => {
    const ug = novaUg();
    const rel = await importar(lote([emp('VM-1', 90_000)], { unidadeGestora: ug }));
    const movimentoId = rel.linhas[0]!.movimentoId!;

    await expect(vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaA })).rejects.toThrow(/justificativa/);
    const v = await vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaA, justificativa: 'Ofício de empenho cita a emenda A' });
    expect(v).toMatchObject({ valorCentavos: 90_000, saldoNaoAlocadoCentavos: 0, pendenciaSemVinculoResolvida: true });
    expect((await listarPendencias(banco.pool)).some((p) => p.movimentoId === movimentoId)).toBe(false);

    const aud = (await app.inject({ method: 'GET', url: `/emendas/${emendaA}/auditoria` })).json() as { entidade: string; entidadeId: string; acao: string; usuario: string }[];
    expect(aud.find((e) => e.entidade === 'movimento_vinculo_emenda' && e.entidadeId === v.vinculoId)).toMatchObject({ acao: 'criar', usuario: 'conferente' });

    // revogar não apaga: reabre a pendência e tira o valor da consulta
    const antes = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!.execucaoFinanceira.empenhadoCentavos;
    const rev = await revogarVinculo(banco.pool, ctx, { vinculoId: v.vinculoId, motivo: 'Vinculado à emenda errada' });
    expect(rev.pendenciaReaberta).toBe(true);
    expect((await consultarExecucaoDaEmenda(banco.pool, emendaA))!.execucaoFinanceira.empenhadoCentavos).toBe(antes - 90_000);
    expect((await listarPendencias(banco.pool)).some((p) => p.movimentoId === movimentoId && p.tipo === 'sem_vinculo')).toBe(true);
    await expect(revogarVinculo(banco.pool, ctx, { vinculoId: v.vinculoId, motivo: 'de novo' })).rejects.toThrow();
    await expect(banco.pool.query('DELETE FROM movimento_vinculo_emenda WHERE id = $1', [v.vinculoId])).rejects.toMatchObject({ code: '23000' });
    const aud2 = (await app.inject({ method: 'GET', url: `/emendas/${emendaA}/auditoria` })).json() as { entidadeId: string; acao: string }[];
    expect(aud2.filter((e) => e.entidadeId === v.vinculoId).map((e) => e.acao)).toEqual(['criar', 'alterar']);
  });
});

describe('rateio entre emendas', () => {
  it('divide um movimento entre emendas e impede soma acima do valor', async () => {
    const rel = await importar(lote([emp('RAT-1', 100_000)]));
    const movimentoId = rel.linhas[0]!.movimentoId!;
    const a = await vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaA, valorCentavos: 60_000, justificativa: 'Rateio acordado, parte A' });
    expect(a.saldoNaoAlocadoCentavos).toBe(40_000);
    // acima do saldo: rejeitado com a regra
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaB, valorCentavos: 40_001, justificativa: 'excesso' })).rejects.toThrow(/excede o valor do movimento/);
    // mesma emenda duas vezes (ativo): conflito
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaA, valorCentavos: 1, justificativa: 'duplicado' })).rejects.toThrow(/já existe/);
    const b = await vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaB, justificativa: 'Restante para B' }); // sem valor => todo o saldo
    expect(b).toMatchObject({ valorCentavos: 40_000, saldoNaoAlocadoCentavos: 0 });
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaB, valorCentavos: 1, justificativa: 'sem saldo' })).rejects.toThrow();

    const ca = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!;
    const cb = (await consultarExecucaoDaEmenda(banco.pool, emendaB))!;
    expect(ca.movimentos.find((m) => m.movimentoId === movimentoId)).toMatchObject({ valorDoMovimentoCentavos: 100_000, valorAlocadoNestaEmendaCentavos: 60_000 });
    expect(cb.movimentos.find((m) => m.movimentoId === movimentoId)).toMatchObject({ valorAlocadoNestaEmendaCentavos: 40_000 });
    // o valor total do movimento não é contado duas vezes
    const soma = await banco.pool.query("SELECT sum(valor_centavos)::int AS s FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL", [movimentoId]);
    expect(soma.rows[0].s).toBe(100_000);
  });

  it('concorrência: dois rateios simultâneos que somariam mais que o movimento — só um passa', async () => {
    for (let i = 0; i < 6; i += 1) {
      const rel = await importar(lote([emp(`CONC-${i}`, 100_000)]));
      const movimentoId = rel.linhas[0]!.movimentoId!;
      const resultados = await Promise.allSettled([
        vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaA, valorCentavos: 70_000, justificativa: 'paralelo A' }),
        vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: emendaB, valorCentavos: 70_000, justificativa: 'paralelo B' }),
      ]);
      expect(resultados.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const soma = await banco.pool.query("SELECT sum(valor_centavos)::int AS s FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL", [movimentoId]);
      expect(soma.rows[0].s).toBe(70_000);
    }
  });

  it('não vincula a emenda de outro exercício nem a emenda cancelada', async () => {
    const ex = await banco.pool.query<{ id: string }>('SELECT id FROM exercicio WHERE ano = 2092');
    const outra = (
      await app.inject({
        method: 'POST', url: '/emendas', headers: h,
        payload: { exercicioId: ex.rows[0]!.id, tipo: 'individual', objeto: 'Ex. 2092', valorPropostoCentavos: 1_000_000, autores: [base.p1] },
      })
    ).json() as { id: string };
    const rel = await importar(lote([emp('EX-1', 1000)]));
    const movimentoId = rel.linhas[0]!.movimentoId!;
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: outra.id, justificativa: 'tentativa' })).rejects.toThrow(/outro exercício/);

    const cancel = await novaEmenda('EMD-CANC');
    const e = (await app.inject({ method: 'GET', url: `/emendas/${cancel}` })).json() as { versao: number };
    await app.inject({ method: 'POST', url: `/emendas/${cancel}/cancelar`, headers: h, payload: { versaoEsperada: e.versao, motivo: 'teste de cancelamento' } });
    await expect(vincularMovimento(banco.pool, ctx, { movimentoId, emendaId: cancel, justificativa: 'tentativa' })).rejects.toThrow(/cancelada/);
  });
});

describe('isolamento entre emendas e consulta', () => {
  it('os dados de uma emenda não aparecem na consulta de outra', async () => {
    const ug = novaUg();
    await importar(lote([emp('ISO-A', 111_000, 'EMD-A'), emp('ISO-B', 222_000, 'EMD-B')], { unidadeGestora: ug }));
    const ca = (await consultarExecucaoDaEmenda(banco.pool, emendaA))!;
    const cb = (await consultarExecucaoDaEmenda(banco.pool, emendaB))!;
    expect(ca.movimentos.some((m) => m.chaveOrigem === 'ISO-A')).toBe(true);
    expect(ca.movimentos.some((m) => m.chaveOrigem === 'ISO-B')).toBe(false);
    expect(cb.movimentos.some((m) => m.chaveOrigem === 'ISO-B')).toBe(true);
    expect(cb.movimentos.some((m) => m.chaveOrigem === 'ISO-A')).toBe(false);
  });

  it('API: somente leitura, 404 para emenda inexistente, sem rota de carga', async () => {
    const r = await app.inject({ method: 'GET', url: `/emendas/${emendaA}/execucao-financeira` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ emendaId: emendaA, exercicio: 2090, origemDosDados: expect.stringContaining('SIMULADO') });
    expect((await app.inject({ method: 'GET', url: '/emendas/00000000-0000-0000-0000-000000000000/execucao-financeira' })).statusCode).toBe(404);
    for (const [method, url] of [['POST', '/importacoes'], ['POST', '/financeiro/importar'], ['POST', `/emendas/${emendaA}/execucao-financeira`], ['PUT', `/emendas/${emendaA}/execucao-financeira`]] as const) {
      expect((await app.inject({ method, url, headers: h, payload: {} })).statusCode).toBeGreaterThanOrEqual(404);
    }
  });

  it('emenda sem movimentos: totais zerados e última importação nula', async () => {
    const vazia = await novaEmenda('EMD-VAZIA');
    const c = (await consultarExecucaoDaEmenda(banco.pool, vazia))!;
    expect(c.execucaoFinanceira.empenhadoCentavos).toBe(0);
    expect(c.ultimaImportacao).toBeNull();
    expect(c.movimentos).toEqual([]);
  });
});

describe('trilha de auditoria e imutabilidade', () => {
  it('importação e vínculos geram eventos de auditoria com usuário e origem; movimentos e linhas são imutáveis', async () => {
    const rel = await importar(lote([emp('AUD-1', 5000, 'EMD-A')]));
    const movimentoId = rel.linhas[0]!.movimentoId!;
    const ev = await banco.pool.query(
      "SELECT entidade, acao, usuario, origem FROM auditoria_evento WHERE entidade_id IN ($1, $2) ORDER BY id",
      [rel.loteId, movimentoId],
    );
    expect(ev.rows).toContainEqual({ entidade: 'importacao_lote', acao: 'criar', usuario: 'importador', origem: 'importacao-cli' });
    expect(ev.rows).toContainEqual({ entidade: 'movimento_financeiro', acao: 'criar', usuario: 'importador', origem: 'importacao-cli' });
    const v = await banco.pool.query<{ id: string; emenda_id: string }>('SELECT id, emenda_id FROM movimento_vinculo_emenda WHERE movimento_id = $1', [movimentoId]);
    const evV = await banco.pool.query('SELECT emenda_id, usuario FROM auditoria_evento WHERE entidade_id = $1', [v.rows[0]!.id]);
    expect(evV.rows).toEqual([{ emenda_id: emendaA, usuario: 'importador' }]);

    await expect(banco.pool.query('UPDATE movimento_financeiro SET valor_centavos = 1 WHERE id = $1', [movimentoId])).rejects.toMatchObject({ code: '23000' });
    await expect(banco.pool.query('DELETE FROM movimento_financeiro WHERE id = $1', [movimentoId])).rejects.toMatchObject({ code: '23000' });
    await expect(banco.pool.query("UPDATE importacao_linha SET resultado = 'rejeitado' WHERE lote_id = $1", [rel.loteId])).rejects.toMatchObject({ code: '23000' });
    await expect(banco.pool.query('DELETE FROM importacao_lote WHERE id = $1', [rel.loteId])).rejects.toMatchObject({ code: '23000' });
  });

  it('o banco recusa encadeamento incoerente e valor não positivo, mesmo fora do importador', async () => {
    const rel = await importar(lote([emp('DB-EMP', 1000), emp('DB-EMP2', 1000)]));
    const [a, b] = rel.linhas.map((l) => l.movimentoId!);
    const l = await banco.pool.query<{ exercicio_id: string; unidade_gestora: string }>('SELECT exercicio_id, unidade_gestora FROM movimento_financeiro WHERE id = $1', [a]);
    const ins = (tipo: string, pai: string | null, valor: number) =>
      banco.pool.query(
        `INSERT INTO movimento_financeiro (origem, exercicio_id, unidade_gestora, chave_origem, tipo, registro_pai_id, data_documento, valor_centavos, hash_conteudo, payload, primeiro_lote_id)
         VALUES ($1,$2,$3,$4,$5,$6,'2090-01-01',$7,$8,'{}',$9)`,
        [ORIGEM, l.rows[0]!.exercicio_id, l.rows[0]!.unidade_gestora, `X-${Math.random()}`, tipo, pai, valor, 'b'.repeat(64), rel.loteId],
      );
    await expect(ins('pagamento', a!, 10)).rejects.toMatchObject({ code: '23514' }); // pagamento precisa de liquidação
    await expect(ins('liquidacao', null, 10)).rejects.toMatchObject({ code: '23514' }); // liquidação precisa de pai
    await expect(ins('empenho', a!, 10)).rejects.toMatchObject({ code: '23514' }); // empenho não tem pai
    await expect(ins('liquidacao', b!, 0)).rejects.toMatchObject({ code: '23514' }); // valor positivo
  });
});

describe('simulação (somente validar)', () => {
  it('mostra o resultado sem gravar lote, movimentos, pendências nem vínculos', async () => {
    const antes = [await contar('importacao_lote'), await contar('movimento_financeiro'), await contar('importacao_pendencia'), await contar('movimento_vinculo_emenda'), await contar('importacao_linha')];
    const rel = await importar(lote([emp('SIM-1', 1000, 'EMD-A'), emp('SIM-2', 2000)]), { somenteValidar: true });
    expect(rel.simulacao).toBe(true);
    expect(rel.totais).toMatchObject({ aceitas: 2, semVinculo: 1 });
    const depois = [await contar('importacao_lote'), await contar('movimento_financeiro'), await contar('importacao_pendencia'), await contar('movimento_vinculo_emenda'), await contar('importacao_linha')];
    expect(depois).toEqual(antes);
  });
});
