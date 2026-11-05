import pg from 'pg';

export type Pool = pg.Pool;

// `date` (OID 1082) volta como texto 'AAAA-MM-DD', sem conversão de fuso.
pg.types.setTypeParser(1082, (v) => v);

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
