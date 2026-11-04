import type { PoolClient } from 'pg';
import type { Pool } from './pool.js';

export interface ContextoAuditoria {
  usuario: string;
  origem: string;
}

/**
 * Executa `fn` em transação, informando ao banco quem está agindo (app.usuario / app.origem).
 * Os gatilhos de auditoria leem esses valores; sem eles, o evento fica como 'desconhecido'.
 */
export async function comTransacao<T>(
  pool: Pool,
  contexto: ContextoAuditoria,
  fn: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT set_config('app.usuario', $1, true), set_config('app.origem', $2, true)", [
      contexto.usuario,
      contexto.origem,
    ]);
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}
