import type { PoolClient } from 'pg';
import type { Pool } from '../../db/pool.js';
import { comTransacao, type ContextoAuditoria } from '../../db/transacao.js';
import { ErroNegocio } from '../../http/erros.js';

/** Converte violações de integridade do banco em erro de negócio com a mensagem da regra violada. */
async function traduzir<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (erro) {
    const e = erro as { code?: string; message: string; constraint?: string };
    if (e.code === '23514' || e.code === '23000') throw new ErroNegocio(422, 'regra_violada', e.message);
    if (e.code === '23505') throw new ErroNegocio(409, 'conflito', `Registro já existe (${e.constraint ?? 'restrição única'})`);
    if (e.code === '23503') throw new ErroNegocio(404, 'referencia_inexistente', 'Movimento ou emenda inexistente');
    if (e.code === '22P02') throw new ErroNegocio(400, 'identificador_invalido', 'Identificador inválido (esperado UUID)');
    throw erro;
  }
}

const texto = (valor: string | undefined, campo: string, min = 3) => {
  const v = valor?.trim() ?? '';
  if (v.length < min) throw new ErroNegocio(400, 'campo_obrigatorio', `${campo} é obrigatório (mínimo ${min} caracteres)`);
  return v;
};

/** Saldo do movimento ainda não alocado a nenhuma emenda (vínculos ativos descontados). */
async function saldoNaoAlocado(c: PoolClient, movimentoId: string): Promise<bigint> {
  const r = await c.query<{ saldo: string }>(
    `SELECT (m.valor_centavos - coalesce((SELECT sum(v.valor_centavos) FROM movimento_vinculo_emenda v
                                          WHERE v.movimento_id = m.id AND v.revogado_em IS NULL), 0))::text AS saldo
       FROM movimento_financeiro m WHERE m.id = $1`,
    [movimentoId],
  );
  if (!r.rows[0]) throw new ErroNegocio(404, 'movimento_nao_encontrado', 'Movimento não encontrado');
  return BigInt(r.rows[0].saldo);
}

export interface VinculoCriado {
  vinculoId: string;
  movimentoId: string;
  emendaId: string;
  valorCentavos: number;
  saldoNaoAlocadoCentavos: number;
  pendenciaSemVinculoResolvida: boolean;
}

/**
 * Decisão MANUAL de vínculo (ou rateio parcial). Exige justificativa. Sem `valorCentavos`, aloca todo o saldo ainda
 * livre do movimento. A soma dos vínculos ativos nunca passa do valor do movimento (garantido pelo banco).
 */
export async function vincularMovimento(
  pool: Pool,
  ctx: ContextoAuditoria,
  d: { movimentoId: string; emendaId: string; valorCentavos?: number; justificativa?: string },
): Promise<VinculoCriado> {
  const justificativa = texto(d.justificativa, 'justificativa');
  return traduzir(() =>
    comTransacao(pool, ctx, async (c) => {
      const saldo = await saldoNaoAlocado(c, d.movimentoId);
      const valor = d.valorCentavos !== undefined ? BigInt(d.valorCentavos) : saldo;
      if (valor <= 0n) throw new ErroNegocio(422, 'sem_saldo', 'Não há saldo a alocar neste movimento');
      const r = await c.query<{ id: string }>(
        `INSERT INTO movimento_vinculo_emenda (movimento_id, emenda_id, valor_centavos, decisao, justificativa, decidido_por)
         VALUES ($1,$2,$3,'manual',$4,$5) RETURNING id`,
        [d.movimentoId, d.emendaId, valor.toString(), justificativa, ctx.usuario],
      );
      const resolvida = await c.query(
        `UPDATE importacao_pendencia SET situacao = 'resolvida', resolucao = $2, resolvida_por = $3, resolvida_em = now()
          WHERE movimento_id = $1 AND tipo IN ('sem_vinculo', 'estorno_sem_alocacao_compativel') AND situacao = 'aberta'`,
        [d.movimentoId, `vinculado manualmente à emenda ${d.emendaId}: ${justificativa}`, ctx.usuario],
      );
      return {
        vinculoId: r.rows[0]!.id,
        movimentoId: d.movimentoId,
        emendaId: d.emendaId,
        valorCentavos: Number(valor),
        saldoNaoAlocadoCentavos: Number(saldo - valor),
        pendenciaSemVinculoResolvida: (resolvida.rowCount ?? 0) > 0,
      };
    }),
  );
}

/** Revoga um vínculo (nunca apaga). Se o movimento ficar sem nenhum vínculo ativo, volta a ficar pendente. */
export async function revogarVinculo(
  pool: Pool,
  ctx: ContextoAuditoria,
  d: { vinculoId: string; motivo?: string },
): Promise<{ vinculoId: string; movimentoId: string; pendenciaReaberta: boolean }> {
  const motivo = texto(d.motivo, 'motivo');
  return traduzir(() =>
    comTransacao(pool, ctx, async (c) => {
      const r = await c.query<{ movimento_id: string }>(
        `UPDATE movimento_vinculo_emenda SET revogado_em = now(), revogado_por = $2, revogacao_motivo = $3
          WHERE id = $1 RETURNING movimento_id`,
        [d.vinculoId, ctx.usuario, motivo],
      );
      if (!r.rows[0]) throw new ErroNegocio(404, 'vinculo_nao_encontrado', 'Vínculo não encontrado');
      const movimentoId = r.rows[0].movimento_id;
      const restantes = await c.query('SELECT 1 FROM movimento_vinculo_emenda WHERE movimento_id = $1 AND revogado_em IS NULL LIMIT 1', [movimentoId]);
      let reaberta = false;
      if (restantes.rowCount === 0) {
        const mov = await c.query<{ primeiro_lote_id: string }>('SELECT primeiro_lote_id FROM movimento_financeiro WHERE id = $1', [movimentoId]);
        await c.query(
          `INSERT INTO importacao_pendencia (lote_id, movimento_id, tipo, detalhes) VALUES ($1,$2,'sem_vinculo',$3::jsonb)`,
          [mov.rows[0]!.primeiro_lote_id, movimentoId, JSON.stringify({ motivo: 'vínculo revogado', vinculoRevogado: d.vinculoId })],
        );
        reaberta = true;
      }
      return { vinculoId: d.vinculoId, movimentoId, pendenciaReaberta: reaberta };
    }),
  );
}

/**
 * Encerra uma pendência de DIVERGÊNCIA após conferência humana. Não altera o movimento: o registro anterior
 * continua valendo. (Aceitar o conteúdo novo exigiria versionar o movimento — ver docs/pendencias.md.)
 * Pendências "sem vínculo" se resolvem vinculando o movimento.
 */
export async function resolverPendenciaDeDivergencia(
  pool: Pool,
  ctx: ContextoAuditoria,
  d: { pendenciaId: string; resolucao?: string },
): Promise<{ pendenciaId: string }> {
  const resolucao = texto(d.resolucao, 'resolução');
  return traduzir(() =>
    comTransacao(pool, ctx, async (c) => {
      const atual = await c.query<{ tipo: string }>('SELECT tipo FROM importacao_pendencia WHERE id = $1 FOR UPDATE', [d.pendenciaId]);
      if (!atual.rows[0]) throw new ErroNegocio(404, 'pendencia_nao_encontrada', 'Pendência não encontrada');
      if (atual.rows[0].tipo !== 'divergencia_origem') {
        throw new ErroNegocio(422, 'tipo_invalido', 'Só pendências de divergência são resolvidas aqui; pendências de vínculo se resolvem vinculando o movimento');
      }
      await c.query(
        `UPDATE importacao_pendencia SET situacao = 'resolvida', resolucao = $2, resolvida_por = $3, resolvida_em = now() WHERE id = $1`,
        [d.pendenciaId, resolucao, ctx.usuario],
      );
      return { pendenciaId: d.pendenciaId };
    }),
  );
}

export async function listarPendencias(pool: Pool, filtro: { todas?: boolean } = {}) {
  const r = await pool.query(
    `SELECT p.id, p.tipo, p.situacao, p.detalhes, p.criado_em AS "criadoEm", p.resolucao, p.resolvida_por AS "resolvidaPor",
            m.id AS "movimentoId", m.chave_origem AS "chaveOrigem", m.tipo AS "tipoMovimento", m.valor_centavos::bigint AS "valorCentavos",
            m.unidade_gestora AS "unidadeGestora", l.origem
       FROM importacao_pendencia p
       JOIN movimento_financeiro m ON m.id = p.movimento_id
       JOIN importacao_lote l ON l.id = p.lote_id
      ${filtro.todas ? '' : "WHERE p.situacao = 'aberta'"}
      ORDER BY p.criado_em, p.id`,
  );
  return r.rows.map((x) => ({ ...x, valorCentavos: Number(x.valorCentavos) }));
}

export async function listarMovimentos(pool: Pool, filtro: { semVinculo?: boolean } = {}) {
  const r = await pool.query(
    `SELECT m.id, m.origem, m.unidade_gestora AS "unidadeGestora", m.chave_origem AS "chaveOrigem", m.tipo, m.numero,
            m.data_documento AS "dataDocumento", m.valor_centavos::bigint AS "valorCentavos",
            (m.valor_centavos - coalesce(a.s, 0))::bigint AS "saldoNaoAlocadoCentavos"
       FROM movimento_financeiro m
       LEFT JOIN (SELECT movimento_id, sum(valor_centavos) AS s FROM movimento_vinculo_emenda WHERE revogado_em IS NULL GROUP BY movimento_id) a
         ON a.movimento_id = m.id
      ${filtro.semVinculo ? 'WHERE a.s IS NULL' : ''}
      ORDER BY m.data_documento, m.criado_em, m.id`,
  );
  return r.rows.map((x) => ({ ...x, valorCentavos: Number(x.valorCentavos), saldoNaoAlocadoCentavos: Number(x.saldoNaoAlocadoCentavos) }));
}
