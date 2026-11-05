/* eslint-disable no-console */
import 'dotenv/config';
import { carregarConfig } from '../config/env.js';
import { executarMigracoes } from '../db/migrar.js';
import { criarPool } from '../db/pool.js';

const config = carregarConfig();
const pool = criarPool(config.DATABASE_URL);
try {
  const r = await executarMigracoes(pool);
  console.log(`Migrações aplicadas: ${r.aplicadas.length ? r.aplicadas.join(', ') : 'nenhuma'}`);
  console.log(`Já aplicadas: ${r.jaAplicadas.length}`);
} catch (erro) {
  console.error((erro as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
