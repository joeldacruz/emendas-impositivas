import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { contextoDeAuditoria } from '../../http/contexto.js';

/** Cadastros mínimos de apoio (exercício e parlamentar). Sem parâmetros legais nesta fase. */
export function rotasCadastros(app: FastifyInstance, pool: Pool) {
  app.get('/exercicios', async () => {
    const { rows } = await pool.query<{ id: string; ano: number }>('SELECT id, ano FROM exercicio ORDER BY ano');
    return rows;
  });

  app.post('/exercicios', async (req, reply) => {
    contextoDeAuditoria(req);
    const { ano } = z.object({ ano: z.number().int().min(1990).max(2100) }).strict().parse(req.body);
    const { rows } = await pool.query<{ id: string; ano: number }>(
      'INSERT INTO exercicio (ano) VALUES ($1) RETURNING id, ano',
      [ano],
    );
    return reply.status(201).send(rows[0]);
  });

  app.get('/parlamentares', async () => {
    const { rows } = await pool.query<{ id: string; nome: string }>('SELECT id, nome FROM parlamentar ORDER BY nome, id');
    return rows;
  });

  app.post('/parlamentares', async (req, reply) => {
    contextoDeAuditoria(req);
    const { nome } = z.object({ nome: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    const { rows } = await pool.query<{ id: string; nome: string }>(
      'INSERT INTO parlamentar (nome) VALUES ($1) RETURNING id, nome',
      [nome],
    );
    return reply.status(201).send(rows[0]);
  });
}
