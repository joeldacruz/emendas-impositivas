import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { uuid } from '../../http/campos.js';
import { ErroNegocio } from '../../http/erros.js';

type Consultavel = Pick<Pool, 'query'>;

const seguro = (v: bigint): number => {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('total excede o inteiro seguro; revisar tipos');
  return Number(v);
};

/**
 * Execução financeira SIMULADA vinculada a UMA emenda. Só entram os valores alocados (vínculos ativos) a ela:
 * dados de outra emenda nunca aparecem. Empenhado, liquidado e pago são separados; estornos são identificáveis.
 * Execução física ("objeto entregue") e prestação de contas aprovada são estados próprios, ainda não apurados aqui.
 */
export async function consultarExecucaoDaEmenda(db: Consultavel, emendaId: string) {
  const e = await db.query<{ valor: string; ano: number }>(
    'SELECT e.valor_proposto_centavos::text AS valor, x.ano FROM emenda e JOIN exercicio x ON x.id = e.exercicio_id WHERE e.id = $1',
    [emendaId],
  );
  if (!e.rows[0]) return null;

  const mov = await db.query<{
    vinculo_id: string;
    alocado: string;
    decisao: string;
    decidido_por: string;
    decidido_em: Date;
    movimento_id: string;
    tipo: string;
    chave_origem: string;
    numero: string | null;
    data_documento: string;
    valor_movimento: string;
    origem: string;
    unidade_gestora: string;
    pai_chave: string | null;
    pai_tipo: string | null;
    divergencia_aberta: boolean;
  }>(
    `SELECT v.id AS vinculo_id, v.valor_centavos::text AS alocado, v.decisao, v.decidido_por, v.decidido_em,
            m.id AS movimento_id, m.tipo, m.chave_origem, m.numero, m.data_documento, m.valor_centavos::text AS valor_movimento,
            m.origem, m.unidade_gestora, pai.chave_origem AS pai_chave, pai.tipo AS pai_tipo,
            EXISTS (SELECT 1 FROM importacao_pendencia p WHERE p.movimento_id = m.id AND p.tipo = 'divergencia_origem' AND p.situacao = 'aberta') AS divergencia_aberta
       FROM movimento_vinculo_emenda v
       JOIN movimento_financeiro m ON m.id = v.movimento_id
       LEFT JOIN movimento_financeiro pai ON pai.id = m.registro_pai_id
      WHERE v.emenda_id = $1 AND v.revogado_em IS NULL
      ORDER BY m.data_documento, m.criado_em, m.id`,
    [emendaId],
  );

  const soma: Record<string, bigint> = { empenho: 0n, liquidacao: 0n, pagamento: 0n, estorno_liquidacao: 0n, estorno_pagamento: 0n };
  for (const m of mov.rows) soma[m.tipo] = (soma[m.tipo] ?? 0n) + BigInt(m.alocado);

  const ultima = await db.query<{ id: string; criado_em: Date; data_referencia: string }>(
    `SELECT lt.id, lt.criado_em, lt.data_referencia
       FROM movimento_vinculo_emenda v
       JOIN importacao_linha li ON li.movimento_id = v.movimento_id AND li.resultado IN ('aceito', 'ja_importado')
       JOIN importacao_lote lt ON lt.id = li.lote_id
      WHERE v.emenda_id = $1 AND v.revogado_em IS NULL
      ORDER BY lt.criado_em DESC, lt.id DESC LIMIT 1`,
    [emendaId],
  );

  // Referência mais recente dos DADOS: nunca retrocede por causa de uma carga histórica (que pode ter referência menor).
  const ref = await db.query<{ ref: string | null }>(
    `SELECT max(lt.data_referencia) AS ref
       FROM movimento_vinculo_emenda v
       JOIN importacao_linha li ON li.movimento_id = v.movimento_id AND li.resultado IN ('aceito', 'ja_importado')
       JOIN importacao_lote lt ON lt.id = li.lote_id
      WHERE v.emenda_id = $1 AND v.revogado_em IS NULL`,
    [emendaId],
  );

  // Pendências abertas que afetam ESTA emenda: estornos sem alocação compatível e divergências dos movimentos vinculados.
  const pend = await db.query<{ id: string; tipo: string; movimento_id: string; chave_origem: string; tipo_movimento: string; detalhes: Record<string, unknown> }>(
    `SELECT p.id, p.tipo, p.movimento_id, m.chave_origem, m.tipo AS tipo_movimento, p.detalhes
       FROM importacao_pendencia p JOIN movimento_financeiro m ON m.id = p.movimento_id
      WHERE p.situacao = 'aberta'
        AND ((p.tipo = 'estorno_sem_alocacao_compativel' AND p.emenda_id = $1)
          OR (p.tipo = 'divergencia_origem' AND p.movimento_id IN
              (SELECT v.movimento_id FROM movimento_vinculo_emenda v WHERE v.emenda_id = $1 AND v.revogado_em IS NULL)))
      ORDER BY p.criado_em, p.id`,
    [emendaId],
  );

  return {
    emendaId,
    exercicio: e.rows[0].ano,
    valorPropostoCentavos: Number(e.rows[0].valor),
    origemDosDados: 'SIMULADO — dados fictícios de desenvolvimento; não é a execução oficial da IPM',
    execucaoFinanceira: {
      empenhadoCentavos: seguro(soma.empenho!),
      liquidadoCentavos: seguro(soma.liquidacao!),
      pagoCentavos: seguro(soma.pagamento!),
      estornoLiquidacaoCentavos: seguro(soma.estorno_liquidacao!),
      estornoPagamentoCentavos: seguro(soma.estorno_pagamento!),
      liquidadoLiquidoDeEstornosCentavos: seguro(soma.liquidacao! - soma.estorno_liquidacao!),
      pagoLiquidoDeEstornosCentavos: seguro(soma.pagamento! - soma.estorno_pagamento!),
    },
    ultimaImportacao: ultima.rows[0]
      ? { loteId: ultima.rows[0].id, importadoEm: ultima.rows[0].criado_em.toISOString(), dataReferencia: ultima.rows[0].data_referencia }
      : null,
    /** Data da última CARGA (quando) e a referência do lote dessa carga — pode ser menor que a referência mais recente. */
    referenciaMaisRecenteDosDados: ref.rows[0]?.ref ?? null,
    divergenciasAbertas: mov.rows.filter((m) => m.divergencia_aberta).length,
    pendenciasAbertas: pend.rows.map((p) => ({
      pendenciaId: p.id,
      tipo: p.tipo,
      movimentoId: p.movimento_id,
      chaveOrigem: p.chave_origem,
      tipoMovimento: p.tipo_movimento,
      motivo:
        p.tipo === 'divergencia_origem'
          ? `conteúdo divergente na origem (campos: ${((p.detalhes.camposDivergentes as string[] | undefined) ?? []).join(', ')}); registro anterior preservado`
          : String(p.detalhes.motivo ?? ''),
    })),
    movimentos: mov.rows.map((m) => ({
      vinculoId: m.vinculo_id,
      movimentoId: m.movimento_id,
      tipo: m.tipo,
      chaveOrigem: m.chave_origem,
      numero: m.numero,
      dataDocumento: m.data_documento,
      valorDoMovimentoCentavos: Number(m.valor_movimento),
      valorAlocadoNestaEmendaCentavos: Number(m.alocado),
      registroPai: m.pai_chave ? { chaveOrigem: m.pai_chave, tipo: m.pai_tipo } : null,
      origem: m.origem,
      unidadeGestora: m.unidade_gestora,
      decisaoDeVinculo: { tipo: m.decisao, por: m.decidido_por, em: m.decidido_em.toISOString() },
      divergenciaAberta: m.divergencia_aberta,
    })),
    naoApurado: {
      objetoEntregue: null,
      prestacaoDeContasAprovada: null,
      observacao:
        'Execução física e prestação de contas são estados próprios (Fase 7) e não decorrem destes valores: empenhado, liquidado ou pago não significam objeto entregue nem contas aprovadas.',
    },
  };
}

/** Somente leitura. A importação e as decisões de vínculo são feitas por comando local (sem autenticação ainda). */
export function rotasExecucaoFinanceira(app: FastifyInstance, pool: Pool) {
  app.get('/emendas/:id/execucao-financeira', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await consultarExecucaoDaEmenda(pool, id);
    if (!r) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
    return r;
  });
}
