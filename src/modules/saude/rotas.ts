import type { FastifyInstance } from 'fastify';
import type { Pool } from '../../db/pool.js';

export function rotasSaude(app: FastifyInstance, pool: Pool, ambiente: string) {
  app.get('/saude', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', banco: 'ok', ambiente };
    } catch {
      return reply.status(503).send({ status: 'degradado', banco: 'indisponivel', ambiente });
    }
  });
}
