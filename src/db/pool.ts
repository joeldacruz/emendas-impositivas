import pg from 'pg';

export type Pool = pg.Pool;

/** Cria o pool. `schema` (opcional) isola as tabelas num schema próprio, usado nos testes. */
export function criarPool(connectionString: string, schema?: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on('error', () => {
    // Erros em conexões ociosas não devem derrubar o processo; a próxima consulta reconecta.
  });
  return pool;
}
