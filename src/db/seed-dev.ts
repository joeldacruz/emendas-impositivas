import type { PoolClient } from 'pg';
import { criarEmenda } from '../modules/emendas/repositorio.js';
import type { Pool } from './pool.js';
import { comTransacao } from './transacao.js';

/**
 * Dados 100% fictícios, apenas para desenvolvimento. Nomes, objetos e valores são inventados;
 * não representam parlamentares, emendas ou valores reais. Idempotente.
 */
export async function semearDesenvolvimento(pool: Pool): Promise<{ criado: boolean }> {
  return comTransacao(pool, { usuario: 'seed-desenvolvimento', origem: 'seed' }, async (c) => {
    const existente = await c.query("SELECT 1 FROM parlamentar WHERE nome LIKE '[FICTÍCIO]%' LIMIT 1");
    if (existente.rowCount) {
      await garantirIdentificadorSimulado(c);
      return { criado: false };
    }

    const ex = await c.query<{ id: string }>(
      'INSERT INTO exercicio (ano) VALUES (2099) ON CONFLICT (ano) DO UPDATE SET ano = EXCLUDED.ano RETURNING id',
    );
    const exercicioId = ex.rows[0]!.id;

    const ids: string[] = [];
    for (const nome of ['[FICTÍCIO] Parlamentar A', '[FICTÍCIO] Parlamentar B', '[FICTÍCIO] Parlamentar C']) {
      const r = await c.query<{ id: string }>('INSERT INTO parlamentar (nome) VALUES ($1) RETURNING id', [nome]);
      ids.push(r.rows[0]!.id);
    }
    const [a, b, cc] = ids as [string, string, string];

    await criarEmenda(c, {
      exercicioId,
      numeroOficial: 'FICT-001',
      tipo: 'individual',
      objeto: '[FICTÍCIO] Aquisição de equipamentos de exemplo',
      valorPropostoCentavos: 1_000_000,
      autores: [a],
    });
    await criarEmenda(c, {
      exercicioId,
      numeroOficial: 'FICT-002',
      tipo: 'individual',
      objeto: '[FICTÍCIO] Reforma de espaço de exemplo',
      valorPropostoCentavos: 2_550_075,
      autores: [b],
    });
    await criarEmenda(c, {
      exercicioId,
      tipo: 'bancada',
      objeto: '[FICTÍCIO] Projeto conjunto de exemplo',
      valorPropostoCentavos: 5_000_000,
      autores: [a, b, cc],
    });
    const banc = await c.query<{ id: string }>(
      "INSERT INTO bancada (exercicio_id, nome) VALUES ($1, '[FICTÍCIO] Bancada Exemplo') RETURNING id",
      [exercicioId],
    );
    const bancadaId = banc.rows[0]!.id;
    await c.query(
      'INSERT INTO bancada_membro (bancada_id, parlamentar_id, vigencia_inicio, vigencia_fim) VALUES ($1,$2,$3,$4), ($1,$5,$6,NULL)',
      [bancadaId, a, '2099-01-01', '2099-06-30', b, '2099-01-01'],
    );
    // Parâmetro fictício, PENDENTE e sem valor jurídico real.
    await c.query(
      `INSERT INTO parametro_legal (exercicio_id, codigo, valor, vigencia_inicio, observacao)
       VALUES ($1, 'FICTICIO_EXEMPLO', '{"valor":"sem significado juridico"}', '2099-01-01', '[FICTÍCIO] apenas para desenvolvimento')`,
      [exercicioId],
    );
    await criarEmenda(c, {
      exercicioId,
      tipo: 'bancada',
      objeto: '[FICTÍCIO] Projeto da bancada de exemplo',
      valorPropostoCentavos: 750_000,
      autores: [],
      bancadas: [bancadaId],
    });
    const ben = await c.query<{ id: string }>(
      "INSERT INTO beneficiario (nome, tipo) VALUES ('[FICTÍCIO] Entidade Beneficiária de Exemplo', 'outro') RETURNING id",
    );
    const emendaComBeneficiario = await c.query<{ id: string }>(
      "SELECT id FROM emenda WHERE numero_oficial = 'FICT-001'",
    );
    await c.query('INSERT INTO emenda_beneficiario (emenda_id, beneficiario_id, valor_centavos) VALUES ($1,$2,$3)', [
      emendaComBeneficiario.rows[0]!.id,
      ben.rows[0]!.id,
      400_000,
    ]);
    await c.query(
      "INSERT INTO emenda_identificador_externo (emenda_id, sistema, tipo_id, valor_id) VALUES ($1, 'fictício', 'emenda', 'FICT-EXT-001')",
      [emendaComBeneficiario.rows[0]!.id],
    );
    const emendaId = emendaComBeneficiario.rows[0]!.id;
    const plano = await c.query<{ id: string }>(
      'INSERT INTO plano_trabalho (emenda_id, numero) VALUES ($1, 1) RETURNING id',
      [emendaId],
    );
    const meta = await c.query<{ id: string }>(
      "INSERT INTO meta (plano_id, ordem, descricao) VALUES ($1, 1, '[FICTÍCIO] Meta de exemplo') RETURNING id",
      [plano.rows[0]!.id],
    );
    const item = await c.query<{ id: string }>(
      "INSERT INTO item_plano (meta_id, ordem, descricao, unidade, quantidade, valor_unitario_centavos) VALUES ($1, 1, '[FICTÍCIO] Item de exemplo', 'un', 10, 50000) RETURNING id",
      [meta.rows[0]!.id],
    );
    await c.query("INSERT INTO cronograma_marco (item_id, descricao, previsto_para) VALUES ($1, '[FICTÍCIO] Entrega de exemplo', '2099-06-30')", [
      item.rows[0]!.id,
    ]);
    await c.query(
      "INSERT INTO tramitacao (emenda_id, titulo, responsavel, prazo, aberta_por) VALUES ($1, '[FICTÍCIO] Etapa de exemplo', '[FICTÍCIO] Setor de exemplo', '2099-03-31', 'seed-desenvolvimento')",
      [emendaId],
    );
    await c.query(
      "INSERT INTO parecer (emenda_id, tipo, texto, autor) VALUES ($1, 'exemplo', '[FICTÍCIO] Texto de parecer de exemplo, sem valor.', 'seed-desenvolvimento')",
      [emendaId],
    );
    await c.query(
      "INSERT INTO diligencia (emenda_id, texto, prazo, aberta_por) VALUES ($1, '[FICTÍCIO] Diligência de exemplo', '2099-04-15', 'seed-desenvolvimento')",
      [emendaId],
    );
    await garantirIdentificadorSimulado(c);
    return { criado: true };
  });
}

/** Identificador da emenda FICT-001 na origem SIMULADA usada pelos lotes de exemplo (exemplos/importacao-financeira). Idempotente. */
async function garantirIdentificadorSimulado(c: PoolClient) {
  await c.query(
    `INSERT INTO emenda_identificador_externo (emenda_id, sistema, tipo_id, valor_id)
     SELECT e.id, 'SIMULADO-FICTICIO', 'emenda', 'FIC-EMD-001'
       FROM emenda e JOIN exercicio x ON x.id = e.exercicio_id
      WHERE e.numero_oficial = 'FICT-001' AND x.ano = 2099
     ON CONFLICT DO NOTHING`,
  );
}
