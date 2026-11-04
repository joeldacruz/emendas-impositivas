import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

const PASTA_PADRAO = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const LOCK_ID = 727_001;

export interface ResultadoMigracao {
  aplicadas: string[];
  jaAplicadas: string[];
}

/**
 * Aplica migrações SQL em ordem de nome. Cada arquivo roda em transação.
 * O checksum de migração já aplicada é verificado: arquivos aplicados não podem ser editados.
 */
export async function executarMigracoes(pool: Pool, pasta: string = PASTA_PADRAO): Promise<ResultadoMigracao> {
  const arquivos = (await readdir(pasta)).filter((f) => f.endsWith('.sql')).sort();
  const cliente = await pool.connect();
  const resultado: ResultadoMigracao = { aplicadas: [], jaAplicadas: [] };
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await cliente.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      nome text PRIMARY KEY,
      checksum text NOT NULL,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await cliente.query<{ nome: string; checksum: string }>(
      'SELECT nome, checksum FROM schema_migrations',
    );
    const aplicadas = new Map(rows.map((r) => [r.nome, r.checksum]));

    for (const arquivo of arquivos) {
      const sql = await readFile(join(pasta, arquivo), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const anterior = aplicadas.get(arquivo);
      if (anterior !== undefined) {
        if (anterior !== checksum) {
          throw new Error(`Migração ${arquivo} foi alterada após ser aplicada. Crie uma nova migração.`);
        }
        resultado.jaAplicadas.push(arquivo);
        continue;
      }
      try {
        await cliente.query('BEGIN');
        await cliente.query(sql);
        await cliente.query('INSERT INTO schema_migrations (nome, checksum) VALUES ($1, $2)', [arquivo, checksum]);
        await cliente.query('COMMIT');
        resultado.aplicadas.push(arquivo);
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw new Error(`Falha na migração ${arquivo}: ${(erro as Error).message}`);
      }
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    cliente.release();
  }
  return resultado;
}
