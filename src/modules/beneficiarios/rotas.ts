import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { uuid } from '../../http/campos.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { ErroNegocio } from '../../http/erros.js';

const COLUNAS = 'id, nome, tipo, documento';

/**
 * Beneficiários. `documento` (CPF/CNPJ, só dígitos) é dado pessoal quando pessoa física:
 * fica restrito à área interna; a publicação só ocorrerá após decisão de LGPD (pendência).
 */
export function rotasBeneficiarios(app: FastifyInstance, pool: Pool) {
  app.get('/beneficiarios', async () => {
    const { rows } = await pool.query(`SELECT ${COLUNAS} FROM beneficiario ORDER BY nome, id`);
    return rows;
  });

  app.get('/beneficiarios/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rows } = await pool.query(`SELECT ${COLUNAS} FROM beneficiario WHERE id = $1`, [id]);
    if (!rows[0]) throw new ErroNegocio(404, 'nao_encontrado', 'Beneficiário não encontrado');
    return rows[0];
  });

  app.post('/beneficiarios', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const d = z
      .object({
        nome: z.string().trim().min(1).max(300),
        tipo: z.enum(['pessoa_juridica', 'pessoa_fisica', 'orgao_publico', 'outro']),
        documento: z
          .string()
          .regex(/^(\d{11}|\d{14})$/, 'informe 11 (CPF) ou 14 (CNPJ) dígitos, sem pontuação')
          .nullish(),
      })
      .strict()
      .parse(req.body);
    const b = await comTransacao(pool, ctx, async (c) => {
      const r = await c.query(`INSERT INTO beneficiario (nome, tipo, documento) VALUES ($1,$2,$3) RETURNING ${COLUNAS}`, [
        d.nome,
        d.tipo,
        d.documento ?? null,
      ]);
      return r.rows[0];
    });
    return reply.status(201).send(b);
  });
}
