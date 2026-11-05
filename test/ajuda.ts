import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { construirApp } from '../src/app.js';
import { executarMigracoes } from '../src/db/migrar.js';
import { criarPool, type Pool } from '../src/db/pool.js';

export interface BancoDeTeste {
  pool: Pool;
  schema: string;
  encerrar: () => Promise<void>;
}

/** Cria um schema isolado no banco de teste, aplica as migrações e devolve um pool preso a ele. */
export async function criarBancoDeTeste(): Promise<BancoDeTeste> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL não definida. Suba o PostgreSQL (docker compose up -d) e copie .env.example para .env, ' +
        'ou exporte TEST_DATABASE_URL. Veja o README.',
    );
  }
  const schema = `teste_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = criarPool(url, schema);
  await executarMigracoes(pool);
  return {
    pool,
    schema,
    encerrar: async () => {
      await pool.end();
      const limpeza = new pg.Client({ connectionString: url });
      await limpeza.connect();
      await limpeza.query(`DROP SCHEMA ${schema} CASCADE`);
      await limpeza.end();
    },
  };
}

export function appDeTeste(pool: Pool) {
  return construirApp(pool, { LOG_LEVEL: 'silent', AMBIENTE: 'teste' });
}

export async function criarBase(pool: Pool) {
  const ex = await pool.query<{ id: string }>('INSERT INTO exercicio (ano) VALUES (2090) RETURNING id');
  const p1 = await pool.query<{ id: string }>("INSERT INTO parlamentar (nome) VALUES ('Teste A') RETURNING id");
  const p2 = await pool.query<{ id: string }>("INSERT INTO parlamentar (nome) VALUES ('Teste B') RETURNING id");
  return { exercicioId: ex.rows[0]!.id, p1: p1.rows[0]!.id, p2: p2.rows[0]!.id };
}
