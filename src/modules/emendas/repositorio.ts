import type { PoolClient } from 'pg';
import type { Pool } from '../../db/pool.js';
import { ErroNegocio } from '../../http/erros.js';

type Consultavel = Pick<PoolClient, 'query'> | Pick<Pool, 'query'>;

export type TipoEmenda = 'individual' | 'bancada';

export interface Emenda {
  id: string;
  exercicioId: string;
  numeroOficial: string | null;
  tipo: TipoEmenda;
  objeto: string;
  valorPropostoCentavos: number;
  situacao: string;
  versao: number;
  criadoEm: string;
  atualizadoEm: string;
  autores: string[];
  bancadas: string[];
  beneficiarios: { beneficiarioId: string; valorCentavos: number | null }[];
  identificadoresExternos: { id: string; sistema: string; tipoId: string; valorId: string }[];
  canceladaEm: string | null;
  cancelamentoMotivo: string | null;
}

export interface NovaEmenda {
  exercicioId: string;
  numeroOficial?: string | null;
  tipo: TipoEmenda;
  objeto: string;
  valorPropostoCentavos: number;
  autores: string[];
  bancadas?: string[];
}

export interface AlteracaoEmenda {
  versaoEsperada: number;
  numeroOficial?: string | null;
  tipo?: TipoEmenda;
  objeto?: string;
  valorPropostoCentavos?: number;
  autores?: string[];
  bancadas?: string[];
}

interface LinhaEmenda {
  id: string;
  exercicio_id: string;
  numero_oficial: string | null;
  tipo: TipoEmenda;
  objeto: string;
  valor_proposto_centavos: string;
  situacao: string;
  versao: number;
  criado_em: Date;
  atualizado_em: Date;
  autores: string[] | null;
  bancadas: string[] | null;
  beneficiarios: { beneficiarioId: string; valorCentavos: string | null }[] | null;
  identificadores: { id: string; sistema: string; tipoId: string; valorId: string }[] | null;
  cancelada_em: Date | null;
  cancelamento_motivo: string | null;
}

const SELECT_EMENDA = `
  SELECT e.*, (
    SELECT array_agg(a.parlamentar_id::text ORDER BY a.parlamentar_id)
    FROM emenda_autoria a WHERE a.emenda_id = e.id AND a.parlamentar_id IS NOT NULL
  ) AS autores, (
    SELECT array_agg(a.bancada_id::text ORDER BY a.bancada_id)
    FROM emenda_autoria a WHERE a.emenda_id = e.id AND a.bancada_id IS NOT NULL
  ) AS bancadas, (
    SELECT jsonb_agg(jsonb_build_object('beneficiarioId', b.beneficiario_id, 'valorCentavos', b.valor_centavos::text)
                     ORDER BY b.criado_em, b.id)
    FROM emenda_beneficiario b WHERE b.emenda_id = e.id
  ) AS beneficiarios, (
    SELECT jsonb_agg(jsonb_build_object('id', i.id, 'sistema', i.sistema, 'tipoId', i.tipo_id, 'valorId', i.valor_id)
                     ORDER BY i.criado_em, i.id)
    FROM emenda_identificador_externo i WHERE i.emenda_id = e.id
  ) AS identificadores
  FROM emenda e`;

function mapear(l: LinhaEmenda): Emenda {
  const valor = Number(l.valor_proposto_centavos);
  if (!Number.isSafeInteger(valor)) {
    throw new Error(`Valor da emenda ${l.id} excede o inteiro seguro do JavaScript`);
  }
  return {
    id: l.id,
    exercicioId: l.exercicio_id,
    numeroOficial: l.numero_oficial,
    tipo: l.tipo,
    objeto: l.objeto,
    valorPropostoCentavos: valor,
    situacao: l.situacao,
    versao: l.versao,
    criadoEm: l.criado_em.toISOString(),
    atualizadoEm: l.atualizado_em.toISOString(),
    autores: l.autores ?? [],
    bancadas: l.bancadas ?? [],
    beneficiarios: (l.beneficiarios ?? []).map((b) => ({
      beneficiarioId: b.beneficiarioId,
      valorCentavos: b.valorCentavos === null ? null : Number(b.valorCentavos),
    })),
    identificadoresExternos: l.identificadores ?? [],
    canceladaEm: l.cancelada_em ? l.cancelada_em.toISOString() : null,
    cancelamentoMotivo: l.cancelamento_motivo,
  };
}

export async function buscarEmenda(db: Consultavel, id: string): Promise<Emenda | null> {
  const { rows } = await db.query<LinhaEmenda>(`${SELECT_EMENDA} WHERE e.id = $1`, [id]);
  return rows[0] ? mapear(rows[0]) : null;
}

export async function listarEmendas(db: Consultavel, exercicioId?: string): Promise<Emenda[]> {
  const { rows } = exercicioId
    ? await db.query<LinhaEmenda>(`${SELECT_EMENDA} WHERE e.exercicio_id = $1 ORDER BY e.criado_em, e.id`, [exercicioId])
    : await db.query<LinhaEmenda>(`${SELECT_EMENDA} ORDER BY e.criado_em, e.id`);
  return rows.map(mapear);
}

export async function criarEmenda(db: PoolClient, dados: NovaEmenda): Promise<Emenda> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO emenda (exercicio_id, numero_oficial, tipo, objeto, valor_proposto_centavos)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [dados.exercicioId, dados.numeroOficial ?? null, dados.tipo, dados.objeto, dados.valorPropostoCentavos],
  );
  const id = rows[0]!.id;
  for (const parlamentarId of dados.autores) {
    await db.query('INSERT INTO emenda_autoria (emenda_id, parlamentar_id) VALUES ($1, $2)', [id, parlamentarId]);
  }
  for (const bancadaId of dados.bancadas ?? []) {
    await db.query('INSERT INTO emenda_autoria (emenda_id, bancada_id) VALUES ($1, $2)', [id, bancadaId]);
  }
  return (await buscarEmenda(db, id))!;
}

export async function alterarEmenda(db: PoolClient, id: string, alt: AlteracaoEmenda): Promise<Emenda> {
  const atual = await db.query<{ versao: number }>('SELECT versao FROM emenda WHERE id = $1 FOR UPDATE', [id]);
  if (!atual.rows[0]) {
    throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
  }
  if (atual.rows[0].versao !== alt.versaoEsperada) {
    throw new ErroNegocio(
      409,
      'versao_desatualizada',
      `A emenda está na versão ${atual.rows[0].versao}; recarregue antes de alterar`,
    );
  }

  const colunas: Record<string, unknown> = {
    numero_oficial: alt.numeroOficial,
    tipo: alt.tipo,
    objeto: alt.objeto,
    valor_proposto_centavos: alt.valorPropostoCentavos,
  };
  const sets: string[] = [];
  const valores: unknown[] = [id];
  for (const [coluna, valor] of Object.entries(colunas)) {
    if (valor !== undefined) {
      valores.push(valor);
      sets.push(`${coluna} = $${valores.length}`);
    }
  }
  if (sets.length > 0) {
    await db.query(`UPDATE emenda SET ${sets.join(', ')} WHERE id = $1`, valores);
  }

  if (alt.autores || alt.bancadas) {
    const { rows } = await db.query<{ parlamentar_id: string | null; bancada_id: string | null }>(
      'SELECT parlamentar_id, bancada_id FROM emenda_autoria WHERE emenda_id = $1',
      [id],
    );
    const atuais = {
      parlamentar_id: new Set(rows.flatMap((r) => (r.parlamentar_id ? [r.parlamentar_id] : []))),
      bancada_id: new Set(rows.flatMap((r) => (r.bancada_id ? [r.bancada_id] : []))),
    };
    let mudou = false;
    for (const [coluna, desejadosLista] of [
      ['parlamentar_id', alt.autores],
      ['bancada_id', alt.bancadas],
    ] as const) {
      if (!desejadosLista) continue;
      const existentes = atuais[coluna];
      const desejados = new Set(desejadosLista);
      for (const x of existentes) {
        if (!desejados.has(x)) {
          await db.query(`DELETE FROM emenda_autoria WHERE emenda_id = $1 AND ${coluna} = $2`, [id, x]);
          mudou = true;
        }
      }
      for (const x of desejados) {
        if (!existentes.has(x)) {
          await db.query(`INSERT INTO emenda_autoria (emenda_id, ${coluna}) VALUES ($1, $2)`, [id, x]);
          mudou = true;
        }
      }
    }
    // Mudança só de autoria também deve gerar nova versão da emenda.
    if (sets.length === 0 && mudou) {
      await db.query('UPDATE emenda SET atualizado_em = now() WHERE id = $1', [id]);
    }
    const restantes = await db.query('SELECT 1 FROM emenda_autoria WHERE emenda_id = $1 LIMIT 1', [id]);
    if (!restantes.rowCount) {
      throw new ErroNegocio(422, 'sem_autoria', 'A emenda precisa ter ao menos um autor (parlamentar ou bancada)');
    }
  }
  return (await buscarEmenda(db, id))!;
}

async function conferirVersao(db: PoolClient, id: string, esperada: number) {
  const r = await db.query<{ versao: number }>('SELECT versao FROM emenda WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rows[0]) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
  if (r.rows[0].versao !== esperada) {
    throw new ErroNegocio(409, 'versao_desatualizada', `A emenda está na versão ${r.rows[0].versao}; recarregue antes de alterar`);
  }
}

/** Muda a situação (cadastrar ou cancelar). As transições válidas são garantidas pelo banco. */
export async function mudarSituacao(
  db: PoolClient,
  id: string,
  versaoEsperada: number,
  destino: 'cadastrada' | 'cancelada',
  motivo?: string,
): Promise<Emenda> {
  await conferirVersao(db, id, versaoEsperada);
  if (destino === 'cancelada') {
    await db.query(
      "UPDATE emenda SET situacao = 'cancelada', cancelada_em = now(), cancelamento_motivo = $2 WHERE id = $1",
      [id, motivo],
    );
  } else {
    await db.query("UPDATE emenda SET situacao = 'cadastrada' WHERE id = $1", [id]);
  }
  return (await buscarEmenda(db, id))!;
}

export async function adicionarBeneficiario(db: PoolClient, emendaId: string, beneficiarioId: string, valorCentavos: number | null) {
  if (!(await buscarEmenda(db, emendaId))) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
  await db.query('INSERT INTO emenda_beneficiario (emenda_id, beneficiario_id, valor_centavos) VALUES ($1,$2,$3)', [
    emendaId,
    beneficiarioId,
    valorCentavos,
  ]);
  return (await buscarEmenda(db, emendaId))!;
}

export async function removerBeneficiario(db: PoolClient, emendaId: string, beneficiarioId: string) {
  const r = await db.query('DELETE FROM emenda_beneficiario WHERE emenda_id = $1 AND beneficiario_id = $2', [emendaId, beneficiarioId]);
  if (!r.rowCount) throw new ErroNegocio(404, 'nao_encontrado', 'Beneficiário não vinculado à emenda');
  return (await buscarEmenda(db, emendaId))!;
}

export async function adicionarIdentificadorExterno(
  db: PoolClient,
  emendaId: string,
  d: { sistema: string; tipoId: string; valorId: string },
) {
  if (!(await buscarEmenda(db, emendaId))) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
  await db.query('INSERT INTO emenda_identificador_externo (emenda_id, sistema, tipo_id, valor_id) VALUES ($1,$2,$3,$4)', [
    emendaId,
    d.sistema,
    d.tipoId,
    d.valorId,
  ]);
  return (await buscarEmenda(db, emendaId))!;
}

export async function removerIdentificadorExterno(db: PoolClient, emendaId: string, identificadorId: string) {
  const r = await db.query('DELETE FROM emenda_identificador_externo WHERE emenda_id = $1 AND id = $2', [emendaId, identificadorId]);
  if (!r.rowCount) throw new ErroNegocio(404, 'nao_encontrado', 'Identificador não encontrado');
  return (await buscarEmenda(db, emendaId))!;
}

export interface EventoAuditoria {
  id: number;
  entidade: string;
  entidadeId: string;
  acao: 'criar' | 'alterar' | 'remover';
  antes: unknown;
  depois: unknown;
  usuario: string;
  origem: string;
  ocorridoEm: string;
}

export async function listarAuditoriaDaEmenda(db: Consultavel, emendaId: string): Promise<EventoAuditoria[]> {
  const { rows } = await db.query<{
    id: string;
    entidade: string;
    entidade_id: string;
    acao: EventoAuditoria['acao'];
    antes: unknown;
    depois: unknown;
    usuario: string;
    origem: string;
    ocorrido_em: Date;
  }>('SELECT * FROM auditoria_evento WHERE emenda_id = $1 ORDER BY id', [emendaId]);
  return rows.map((r) => ({
    id: Number(r.id),
    entidade: r.entidade,
    entidadeId: r.entidade_id,
    acao: r.acao,
    antes: r.antes,
    depois: r.depois,
    usuario: r.usuario,
    origem: r.origem,
    ocorridoEm: r.ocorrido_em.toISOString(),
  }));
}
