import 'dotenv/config';
import { construirApp } from './app.js';
import { carregarConfig } from './config/env.js';
import { criarPool } from './db/pool.js';

const config = carregarConfig();
const pool = criarPool(config.DATABASE_URL);
const app = construirApp(pool, config);

async function encerrar() {
  await app.close();
  await pool.end();
}
process.on('SIGINT', () => void encerrar());
process.on('SIGTERM', () => void encerrar());

app.listen({ host: config.HOST, port: config.PORT }).catch((erro) => {
  app.log.error(erro);
  process.exit(1);
});
