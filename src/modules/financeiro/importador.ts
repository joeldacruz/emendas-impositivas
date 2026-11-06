import type { PoolClient } from 'pg';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import {
  CAMPOS_DO_CONTEUDO,
  ErroFormato,
  TIPO_DO_PAI,
  conteudoCanonico,
  hashDoConteudo,
  validarCabecalho,
  validarRegistro,
  type Cabecalho,
  type RegistroValido,
} from './formato.js';

const LOCK_IMPORTACAO = 727_006;

export type ResultadoLinha = 'aceito' | 'ja_importado' | 'divergente' | 'rejeitado';

export interface LinhaRelatorio {
  numeroLinha: number;
  chaveOrigem: string | null;
  tipo: string | null;
  resultado: ResultadoLinha;
  motivos: string[];
  semVinculo: boolean;
  movimentoId: string | null;
  pendenciaId: string | null;
}

export interface RelatorioImportacao {
  loteId: string;
  simulacao: boolean;
  origem: string;
  exercicio: number;
  unidadeGestora: string;
  dataReferencia: string;
  arquivoSha256: string;
  totais: { linhas: number; aceitas: number; jaImportadas: number; divergentes: number; rejeitadas: number; semVinculo: number };
  linhas: LinhaRelatorio[];
}

export interface MetaImportacao {
  usuario: string;
  arquivoNome?: string | null;
  arquivoSha256: string;
  /** Roda tudo, devolve o relatório e desfaz a transação: nada fica gravado. */
  somenteValidar?: boolean;
}

class Simulacao extends Error {
  constructor(public readonly relatorio: RelatorioImportacao) {
    super('simulação');
  }
}

interface Escopo {
  origem: string;
  exercicioId: string;
  unidadeGestora: string;
}

interface Desfecho {
  resultado: ResultadoLinha;
  motivos: string[];
  semVinculo: boolean;
  movimentoId: string | null;
  pendenciaId: string | null;
  hash: string | null;
  /** Rejeição só por dependência ainda não satisfeita (pai ausente ou saldo): a linha é reavaliada depois das demais. */
  adiavel: boolean;
}

const rejeitado = (motivos: string[], hash: string | null = null, adiavel = false): Desfecho => ({
  resultado: 'rejeitado',
  motivos,
  semVinculo: false,
  movimentoId: null,
  pendenciaId: null,
  hash,
  adiavel,
});

const brl = (centavos: bigint | number) => {
  const v = BigInt(centavos);
  const abs = v < 0n ? -v : v;
  return `R$ ${abs / 100n},${String(abs % 100n).padStart(2, '0')}`;
};

/**
 * Importa um lote no formato interno v1. Fluxo:
 *  1. cabeçalho inválido => nada é gravado (erro com os motivos);
 *  2. cada registro é validado; os inválidos viram linhas "rejeitado" com o motivo;
 *  3. os válidos são consolidados na ordem pai -> filho, em uma única transação.
 * Mesma chave + mesmo conteúdo => ignorado (idempotente). Mesma chave + conteúdo diferente => o registro anterior
 * é preservado e abre-se pendência de conferência. Vínculo com emenda só pelo identificador cadastrado.
 */
export async function importarLote(pool: Pool, conteudo: unknown, meta: MetaImportacao): Promise<RelatorioImportacao> {
  const cab = validarCabecalho(conteudo);
  try {
    return await comTransacao(pool, { usuario: meta.usuario, origem: 'importacao-cli' }, async (c) => {
      const rel = await executar(c, cab, meta);
      if (meta.somenteValidar) throw new Simulacao(rel);
      return rel;
    });
  } catch (erro) {
    if (erro instanceof Simulacao) return { ...erro.relatorio, simulacao: true };
    throw erro;
  }
}

async function executar(c: PoolClient, cab: Cabecalho, meta: MetaImportacao): Promise<RelatorioImportacao> {
  // Importações são serializadas: duas ao mesmo tempo não disputam as mesmas chaves.
  await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_IMPORTACAO]);
  const ex = await c.query<{ id: string }>('SELECT id FROM exercicio WHERE ano = $1', [cab.exercicio]);
  if (!ex.rows[0]) throw new ErroFormato([`exercício ${cab.exercicio} não está cadastrado no sistema`]);
  const escopo: Escopo = { origem: cab.origem, exercicioId: ex.rows[0].id, unidadeGestora: cab.unidadeGestora };

  const lote = await c.query<{ id: string }>(
    `INSERT INTO importacao_lote (origem, exercicio_id, unidade_gestora, data_referencia, formato_versao, arquivo_nome, arquivo_sha256, importado_por)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7) RETURNING id`,
    [cab.origem, escopo.exercicioId, cab.unidadeGestora, cab.dataReferencia, meta.arquivoNome ?? null, meta.arquivoSha256, meta.usuario],
  );
  const loteId = lote.rows[0]!.id;

  const itens = cab.registros.map((bruto, i) => ({ numero: i + 1, bruto, v: validarRegistro(bruto) }));
  const linhas: LinhaRelatorio[] = [];

  const gravarLinha = async (numero: number, bruto: unknown, registro: RegistroValido | null, d: Desfecho) => {
    const chave = registro?.chaveOrigem ?? chaveBruta(bruto);
    const tipo = registro?.tipo ?? tipoBruto(bruto);
    await c.query(
      `INSERT INTO importacao_linha (lote_id, numero_linha, chave_origem, tipo, resultado, motivos, sem_vinculo, movimento_id, hash_conteudo, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb)`,
      [loteId, numero, chave, tipo, d.resultado, JSON.stringify(d.motivos), d.semVinculo, d.movimentoId, d.hash, JSON.stringify(bruto ?? null)],
    );
    linhas.push({
      numeroLinha: numero,
      chaveOrigem: chave,
      tipo,
      resultado: d.resultado,
      motivos: d.motivos,
      semVinculo: d.semVinculo,
      movimentoId: d.movimentoId,
      pendenciaId: d.pendenciaId,
    });
  };

  // 1) rejeições de formato (não consolidam nada)
  for (const it of itens) {
    if (!it.v.ok) await gravarLinha(it.numero, it.bruto, null, rejeitado(it.v.motivos));
  }

  // 2) válidos. O formato não traz sequência de lançamento, então NENHUMA cronologia é inventada:
  //    - ordem inicial: dataDocumento (informada pela origem) e, no empate, posição no arquivo;
  //    - linha rejeitada apenas por dependência (pai ausente ou saldo insuficiente) é reavaliada depois das demais,
  //      assim que uma linha é aceita (e antes das ainda não tentadas), até a fila acabar sem progresso;
  //    - assim um estorno válido libera saldo para uma reposição, em qualquer ordem do arquivo.
  //    Quando duas linhas disputam o mesmo saldo, vale a de menor (data, posição); a outra é rejeitada com motivo.
  type Item = { numero: number; bruto: unknown; registro: RegistroValido };
  const fila: Item[] = itens
    .flatMap((it) => (it.v.ok ? [{ numero: it.numero, bruto: it.bruto, registro: it.v.registro }] : []))
    .sort((a, b) => (a.registro.dataDocumento < b.registro.dataDocumento ? -1 : a.registro.dataDocumento > b.registro.dataDocumento ? 1 : a.numero - b.numero));

  const tentar = async (it: Item): Promise<Desfecho> => {
    await c.query('SAVEPOINT linha');
    try {
      const d = await processar(c, escopo, cab, loteId, it.bruto, it.registro, meta.usuario);
      await c.query('RELEASE SAVEPOINT linha');
      return d;
    } catch (erro) {
      const codigo = (erro as { code?: string }).code;
      if (typeof codigo === 'string' && codigo.startsWith('23')) {
        await c.query('ROLLBACK TO SAVEPOINT linha');
        return rejeitado([`regra de integridade do banco: ${(erro as Error).message}`], hashDoConteudo(it.registro));
      }
      throw erro;
    }
  };

  // Fila de trabalho. Uma linha adiada (só por dependência) volta à fila exatamente quando uma linha é ACEITA
  // (só uma aceitação cria pai ou libera/consome saldo), e volta À FRENTE das linhas ainda não tentadas: as
  // adiadas são as de menor (data, posição), então têm a primeira oportunidade sobre o saldo liberado.
  // Termina porque cada reentrada é causada por uma aceitação (finitas) e, esgotada a fila, o que restar
  // adiado é rejeitado em definitivo, com o motivo da última tentativa.
  const adiadas: { it: Item; d: Desfecho }[] = [];
  while (fila.length > 0) {
    const it = fila.shift()!;
    const d = await tentar(it);
    if (d.adiavel) {
      adiadas.push({ it, d });
      continue;
    }
    await gravarLinha(it.numero, it.bruto, it.registro, d);
    if (d.resultado === 'aceito' && adiadas.length > 0) {
      fila.unshift(...adiadas.splice(0).map((a) => a.it));
    }
  }
  for (const { it, d } of adiadas) await gravarLinha(it.numero, it.bruto, it.registro, { ...d, adiavel: false });

  linhas.sort((a, b) => a.numeroLinha - b.numeroLinha);
  const conta = (r: ResultadoLinha) => linhas.filter((l) => l.resultado === r).length;
  const totais = {
    linhas: linhas.length,
    aceitas: conta('aceito'),
    jaImportadas: conta('ja_importado'),
    divergentes: conta('divergente'),
    rejeitadas: conta('rejeitado'),
    semVinculo: linhas.filter((l) => l.semVinculo).length,
  };
  await c.query(
    `UPDATE importacao_lote SET total_linhas=$2, aceitas=$3, ja_importadas=$4, divergentes=$5, rejeitadas=$6, sem_vinculo=$7 WHERE id=$1`,
    [loteId, totais.linhas, totais.aceitas, totais.jaImportadas, totais.divergentes, totais.rejeitadas, totais.semVinculo],
  );

  return {
    loteId,
    simulacao: false,
    origem: cab.origem,
    exercicio: cab.exercicio,
    unidadeGestora: cab.unidadeGestora,
    dataReferencia: cab.dataReferencia,
    arquivoSha256: meta.arquivoSha256,
    totais,
    linhas,
  };
}

const chaveBruta = (b: unknown) =>
  b && typeof b === 'object' && typeof (b as Record<string, unknown>).chaveOrigem === 'string'
    ? ((b as Record<string, unknown>).chaveOrigem as string).slice(0, 120)
    : null;
const tipoBruto = (b: unknown) =>
  b && typeof b === 'object' && typeof (b as Record<string, unknown>).tipo === 'string'
    ? ((b as Record<string, unknown>).tipo as string).slice(0, 40)
    : null;

interface LinhaMovimento {
  id: string;
  tipo: string;
  numero: string | null;
  exercicio_documento: number | null;
  data_documento: string;
  valor: string;
  dotacao: string | null;
  credor_nome: string | null;
  identificador_emenda: string | null;
  hash_conteudo: string;
  pai_chave: string | null;
}

async function processar(
  c: PoolClient,
  escopo: Escopo,
  cab: Cabecalho,
  loteId: string,
  bruto: unknown,
  rec: RegistroValido,
  usuario: string,
): Promise<Desfecho> {
  const hash = hashDoConteudo(rec);

  // Verificações do lote vêm ANTES de qualquer classificação por duplicidade ou divergência: um movimento posterior
  // à data de referência não pode sair como "já importado" nem gerar pendência de divergência.
  const doLote: string[] = [];
  if (rec.dataDocumento > cab.dataReferencia) {
    doLote.push(`dataDocumento ${rec.dataDocumento} é posterior à data de referência do lote (${cab.dataReferencia})`);
  }
  if (rec.exercicioDocumento !== null && rec.exercicioDocumento !== cab.exercicio) {
    doLote.push(
      `exercicioDocumento ${rec.exercicioDocumento} difere do exercício do lote (${cab.exercicio}); restos a pagar e documentos de outro exercício ainda não são suportados (ver docs/pendencias.md)`,
    );
  }
  if (doLote.length) return rejeitado(doLote, hash);

  const existente = await c.query<LinhaMovimento>(
    `SELECT m.id, m.tipo, m.numero, m.exercicio_documento, m.data_documento, m.valor_centavos::text AS valor, m.dotacao,
            m.credor_nome, m.identificador_emenda, m.hash_conteudo, pai.chave_origem AS pai_chave
       FROM movimento_financeiro m LEFT JOIN movimento_financeiro pai ON pai.id = m.registro_pai_id
      WHERE m.origem = $1 AND m.exercicio_id = $2 AND m.unidade_gestora = $3 AND m.chave_origem = $4`,
    [escopo.origem, escopo.exercicioId, escopo.unidadeGestora, rec.chaveOrigem],
  );
  const antigo = existente.rows[0];

  if (antigo) {
    if (antigo.hash_conteudo === hash) {
      const v = await c.query('SELECT 1 FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL LIMIT 1', [antigo.id]);
      return {
        resultado: 'ja_importado',
        motivos: ['mesma chave e mesmo conteúdo já importados; nada alterado'],
        semVinculo: v.rowCount === 0,
        movimentoId: antigo.id,
        pendenciaId: null,
        hash,
        adiavel: false,
      };
    }
    return divergencia(c, loteId, antigo, rec, hash);
  }

  // ----- novo movimento: validações que dependem do estado do banco
  const finais: string[] = [];
  const adiaveis: string[] = [];

  let pai: { id: string; tipo: string; dataDocumento: string; valor: bigint } | null = null;
  if (rec.registroPaiChave) {
    const p = await c.query<{ id: string; tipo: string; data_documento: string; valor: string }>(
      `SELECT id, tipo, data_documento, valor_centavos::text AS valor FROM movimento_financeiro
        WHERE origem = $1 AND exercicio_id = $2 AND unidade_gestora = $3 AND chave_origem = $4`,
      [escopo.origem, escopo.exercicioId, escopo.unidadeGestora, rec.registroPaiChave],
    );
    const linhaPai = p.rows[0];
    if (!linhaPai) {
      adiaveis.push(
        `registroPaiChave "${rec.registroPaiChave}" não encontrado nesta origem, exercício e unidade gestora (nem neste lote, nem em lotes anteriores)`,
      );
    } else if (linhaPai.tipo !== TIPO_DO_PAI[rec.tipo]) {
      finais.push(`${rec.tipo} deve referenciar um ${TIPO_DO_PAI[rec.tipo]}, mas "${rec.registroPaiChave}" é ${linhaPai.tipo}`);
    } else {
      pai = { id: linhaPai.id, tipo: linhaPai.tipo, dataDocumento: linhaPai.data_documento, valor: BigInt(linhaPai.valor) };
      if (rec.dataDocumento < pai.dataDocumento) {
        finais.push(`dataDocumento ${rec.dataDocumento} é anterior à do registro pai (${pai.dataDocumento})`);
      }
    }
  }
  if (pai && finais.length === 0) {
    const saldo = await validarSaldos(c, rec, pai);
    if (saldo) adiaveis.push(saldo);
  }
  if (finais.length) return rejeitado([...finais, ...adiaveis], hash);
  if (adiaveis.length) return rejeitado(adiaveis, hash, true);

  const ins = await c.query<{ id: string }>(
    `INSERT INTO movimento_financeiro (origem, exercicio_id, unidade_gestora, chave_origem, tipo, registro_pai_id, numero, exercicio_documento,
       data_documento, valor_centavos, dotacao, credor_nome, identificador_emenda, hash_conteudo, payload, primeiro_lote_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING id`,
    [
      escopo.origem, escopo.exercicioId, escopo.unidadeGestora, rec.chaveOrigem, rec.tipo, pai?.id ?? null, rec.numero, rec.exercicioDocumento,
      rec.dataDocumento, rec.valorCentavos, rec.dotacao, rec.credorNome, rec.identificadorEmenda, hash, JSON.stringify(bruto), loteId,
    ],
  );
  const movimentoId = ins.rows[0]!.id;

  // ----- vínculo: só pelo identificador de emenda previamente cadastrado. Nada de dedução por credor ou valor.
  let motivoSemVinculo: string | null = null;
  let estornoSemAlocacao: { emendaId: string; parcelaNestaEmenda: bigint; estornosNestaEmenda: bigint } | null = null;
  if (!rec.identificadorEmenda) {
    motivoSemVinculo = 'movimento sem identificadorEmenda: vínculo deve ser decidido manualmente';
  } else {
    const e = await c.query<{ id: string; exercicio_id: string; situacao: string }>(
      `SELECT e.id, e.exercicio_id, e.situacao FROM emenda_identificador_externo i JOIN emenda e ON e.id = i.emenda_id
        WHERE i.sistema = $1 AND i.tipo_id = 'emenda' AND i.valor_id = $2`,
      [escopo.origem, rec.identificadorEmenda],
    );
    const emenda = e.rows[0];
    if (!emenda) {
      motivoSemVinculo = `identificadorEmenda "${rec.identificadorEmenda}" não está cadastrado como identificador externo (sistema ${escopo.origem}, tipo emenda)`;
    } else if (emenda.exercicio_id !== escopo.exercicioId) {
      motivoSemVinculo = `a emenda do identificador "${rec.identificadorEmenda}" pertence a outro exercício`;
    } else if (emenda.situacao === 'cancelada') {
      motivoSemVinculo = `a emenda do identificador "${rec.identificadorEmenda}" está cancelada`;
    } else {
      // Estorno: só abate a parcela do movimento ORIGINAL alocada à MESMA emenda (acumulando os estornos anteriores).
      const incompat = pai && (rec.tipo === 'estorno_liquidacao' || rec.tipo === 'estorno_pagamento') ? await estornoSemLastro(c, pai.id, rec.tipo, emenda.id, rec.valorCentavos) : null;
      if (incompat) {
        estornoSemAlocacao = { emendaId: emenda.id, ...incompat };
      } else {
        await c.query(
          `INSERT INTO movimento_vinculo_emenda (movimento_id, emenda_id, valor_centavos, decisao, decidido_por)
           VALUES ($1,$2,$3,'identificador_externo',$4)`,
          [movimentoId, emenda.id, rec.valorCentavos, usuario],
        );
      }
    }
  }

  let pendenciaId: string | null = null;
  if (estornoSemAlocacao) {
    // A pendência é da emenda afetada e não revela a alocação de nenhuma outra emenda.
    motivoSemVinculo =
      `estorno de ${brl(rec.valorCentavos)} sem alocação compatível: o movimento original tem ${brl(estornoSemAlocacao.parcelaNestaEmenda)} alocados a esta emenda e ${brl(estornoSemAlocacao.estornosNestaEmenda)} de estornos já alocados a ela`;
    const pend = await c.query<{ id: string }>(
      `INSERT INTO importacao_pendencia (lote_id, movimento_id, tipo, emenda_id, detalhes)
       VALUES ($1,$2,'estorno_sem_alocacao_compativel',$3,$4::jsonb) RETURNING id`,
      [
        loteId,
        movimentoId,
        estornoSemAlocacao.emendaId,
        JSON.stringify({
          motivo: motivoSemVinculo,
          identificadorEmenda: rec.identificadorEmenda,
          valorDoEstornoCentavos: rec.valorCentavos,
          parcelaDoOriginalNestaEmendaCentavos: Number(estornoSemAlocacao.parcelaNestaEmenda),
          estornosJaAlocadosNestaEmendaCentavos: Number(estornoSemAlocacao.estornosNestaEmenda),
        }),
      ],
    );
    pendenciaId = pend.rows[0]!.id;
  } else if (motivoSemVinculo) {
    const pend = await c.query<{ id: string }>(
      `INSERT INTO importacao_pendencia (lote_id, movimento_id, tipo, detalhes) VALUES ($1,$2,'sem_vinculo',$3::jsonb) RETURNING id`,
      [loteId, movimentoId, JSON.stringify({ motivo: motivoSemVinculo, identificadorEmenda: rec.identificadorEmenda })],
    );
    pendenciaId = pend.rows[0]!.id;
  }

  return {
    resultado: 'aceito',
    motivos: motivoSemVinculo ? [`aceito, mas sem vínculo: ${motivoSemVinculo}`] : [],
    semVinculo: motivoSemVinculo !== null,
    movimentoId,
    pendenciaId,
    hash,
    adiavel: false,
  };
}

async function divergencia(c: PoolClient, loteId: string, antigo: LinhaMovimento, rec: RegistroValido, hash: string): Promise<Desfecho> {
  const anterior = {
    tipo: antigo.tipo,
    registroPaiChave: antigo.pai_chave,
    numero: antigo.numero,
    exercicioDocumento: antigo.exercicio_documento,
    dataDocumento: antigo.data_documento,
    valorCentavos: Number(antigo.valor),
    dotacao: antigo.dotacao,
    credorNome: antigo.credor_nome,
    identificadorEmenda: antigo.identificador_emenda,
  };
  const recebido = conteudoCanonico(rec);
  const campos = CAMPOS_DO_CONTEUDO.filter((k) => anterior[k] !== recebido[k]);
  const diferencas = campos.map((k) => `${k}: ${String(anterior[k])} -> ${String(recebido[k])}`);

  const nova = await c.query<{ id: string }>(
    `INSERT INTO importacao_pendencia (lote_id, movimento_id, tipo, detalhes, hash_divergente)
     VALUES ($1,$2,'divergencia_origem',$3::jsonb,$4)
     ON CONFLICT (movimento_id, hash_divergente) WHERE tipo = 'divergencia_origem' DO NOTHING RETURNING id`,
    [loteId, antigo.id, JSON.stringify({ hashAnterior: antigo.hash_conteudo, hashRecebido: hash, camposDivergentes: campos, anterior, recebido }), hash],
  );
  let pendenciaId = nova.rows[0]?.id ?? null;
  let nota: string;
  if (pendenciaId) {
    nota = `pendência de conferência aberta (${pendenciaId})`;
  } else {
    const ja = await c.query<{ id: string; situacao: string }>(
      `SELECT id, situacao FROM importacao_pendencia WHERE movimento_id = $1 AND tipo = 'divergencia_origem' AND hash_divergente = $2`,
      [antigo.id, hash],
    );
    pendenciaId = ja.rows[0]!.id;
    nota = `este mesmo conteúdo divergente já gerou a pendência ${pendenciaId} (${ja.rows[0]!.situacao}); nenhuma pendência nova`;
  }
  return {
    resultado: 'divergente',
    motivos: ['mesma chave com conteúdo diferente; registro anterior preservado', ...diferencas, nota],
    semVinculo: false,
    movimentoId: antigo.id,
    pendenciaId,
    hash,
    adiavel: false,
  };
}

// ---------------------------------------------------------------- Consistência da cadeia empenho -> liquidação -> pagamento
async function somaFilhos(c: PoolClient, paiId: string, tipo: string): Promise<bigint> {
  const r = await c.query<{ s: string }>(
    'SELECT coalesce(sum(valor_centavos), 0)::text AS s FROM movimento_financeiro WHERE registro_pai_id = $1 AND tipo = $2',
    [paiId, tipo],
  );
  return BigInt(r.rows[0]!.s);
}

/** Soma dos filhos diretos de `paiId` do tipo `tipo`, descontados os estornos que apontam para cada um. */
async function somaLiquida(c: PoolClient, paiId: string, tipo: 'liquidacao' | 'pagamento'): Promise<bigint> {
  const tipoEstorno = tipo === 'liquidacao' ? 'estorno_liquidacao' : 'estorno_pagamento';
  const r = await c.query<{ s: string }>(
    `SELECT coalesce(sum(f.valor_centavos - coalesce(e.s, 0)), 0)::text AS s
       FROM movimento_financeiro f
       LEFT JOIN (SELECT registro_pai_id, sum(valor_centavos) AS s FROM movimento_financeiro WHERE tipo = $3 GROUP BY registro_pai_id) e
         ON e.registro_pai_id = f.id
      WHERE f.registro_pai_id = $1 AND f.tipo = $2`,
    [paiId, tipo, tipoEstorno],
  );
  return BigInt(r.rows[0]!.s);
}

async function validarSaldos(c: PoolClient, rec: RegistroValido, pai: { id: string; valor: bigint }): Promise<string | null> {
  const novo = BigInt(rec.valorCentavos);
  switch (rec.tipo) {
    case 'liquidacao': {
      const liquidado = await somaLiquida(c, pai.id, 'liquidacao');
      return liquidado + novo > pai.valor
        ? `liquidação de ${brl(novo)} excede o saldo do empenho (empenhado ${brl(pai.valor)}, já liquidado líquido de estornos ${brl(liquidado)})`
        : null;
    }
    case 'pagamento': {
      const liquidacaoLiquida = pai.valor - (await somaFilhos(c, pai.id, 'estorno_liquidacao'));
      const pago = await somaLiquida(c, pai.id, 'pagamento');
      return pago + novo > liquidacaoLiquida
        ? `pagamento de ${brl(novo)} excede o saldo da liquidação (liquidada líquida ${brl(liquidacaoLiquida)}, já paga líquida de estornos ${brl(pago)})`
        : null;
    }
    case 'estorno_liquidacao': {
      const estornado = (await somaFilhos(c, pai.id, 'estorno_liquidacao')) + novo;
      if (estornado > pai.valor) return `estorno de liquidação de ${brl(novo)} excede o valor da liquidação (${brl(pai.valor)}; estornos somariam ${brl(estornado)})`;
      const pago = await somaLiquida(c, pai.id, 'pagamento');
      return pai.valor - estornado < pago
        ? `estorno de liquidação de ${brl(novo)} deixaria a liquidação (${brl(pai.valor - estornado)}) abaixo do já pago (${brl(pago)}); estorne o pagamento antes`
        : null;
    }
    case 'estorno_pagamento': {
      const estornado = (await somaFilhos(c, pai.id, 'estorno_pagamento')) + novo;
      return estornado > pai.valor ? `estorno de pagamento de ${brl(novo)} excede o valor do pagamento (${brl(pai.valor)}; estornos somariam ${brl(estornado)})` : null;
    }
    default:
      return null;
  }
}

/**
 * Compatibilidade de um estorno com a emenda: parcela do original alocada a ela (vínculos ativos) menos os estornos
 * irmãos já alocados a ela. Devolve null se couber; senão os números (só desta emenda) para a pendência.
 */
async function estornoSemLastro(
  c: PoolClient,
  paiId: string,
  tipo: string,
  emendaId: string,
  valor: number,
): Promise<{ parcelaNestaEmenda: bigint; estornosNestaEmenda: bigint } | null> {
  const p = await c.query<{ s: string }>(
    `SELECT coalesce(sum(valor_centavos), 0)::text AS s FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND emenda_id = $2 AND revogado_em IS NULL`,
    [paiId, emendaId],
  );
  const e = await c.query<{ s: string }>(
    `SELECT coalesce(sum(ve.valor_centavos), 0)::text AS s FROM movimento_vinculo_emenda ve JOIN movimento_financeiro f ON f.id = ve.movimento_id
      WHERE f.registro_pai_id = $1 AND f.tipo = $2 AND ve.emenda_id = $3 AND ve.revogado_em IS NULL`,
    [paiId, tipo, emendaId],
  );
  const parcela = BigInt(p.rows[0]!.s);
  const estornos = BigInt(e.rows[0]!.s);
  return estornos + BigInt(valor) > parcela ? { parcelaNestaEmenda: parcela, estornosNestaEmenda: estornos } : null;
}
