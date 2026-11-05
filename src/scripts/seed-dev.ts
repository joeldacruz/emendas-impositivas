/* eslint-disable no-console */
import 'dotenv/config';
import { carregarConfig } from '../config/env.js';
import { criarPool } from '../db/pool.js';
import { semearDesenvolvimento } from '../db/seed-dev.js';

const config = carregarConfig();
if (config.AMBIENTE !== 'desenvolvimento') {
  console.error(`Seed recusado: AMBIENTE=${config.AMBIENTE}. Dados fictícios só rodam em AMBIENTE=desenvolvimento.`);
  process.exit(1);
}
const pool = criarPool(config.DATABASE_URL);
try {
  const r = await semearDesenvolvimento(pool);
  console.log(r.criado ? 'Dados fictícios de desenvolvimento criados.' : 'Dados fictícios já existem; nada a fazer.');
} finally {
  await pool.end();
}
