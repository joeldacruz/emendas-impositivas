import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { ErroNegocio } from '../../http/erros.js';
import { alterarEmenda, buscarEmenda, criarEmenda, listarAuditoriaDaEmenda, listarEmendas } from './repositorio.js';

const uuid = z.string().uuid();
const centavos = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const texto = z.string().trim().min(1).max(4000);
const autores = z.array(uuid).max(50);

const novaEmenda = z
  .object({
    exercicioId: uuid,
    numeroOficial: z.string().trim().min(1).max(60).nullish(),
    tipo: z.enum(['individual', 'bancada']),
    objeto: texto,
    valorPropostoCentavos: centavos,
    autores,
    bancadas: z.array(uuid).max(50).default([]),
  })
  .strict()
  .refine((v) => new Set(v.autores).size === v.autores.length, { message: 'autores repetidos', path: ['autores'] })
  .refine((v) => new Set(v.bancadas).size === v.bancadas.length, { message: 'bancadas repetidas', path: ['bancadas'] })
  .refine((v) => v.autores.length + v.bancadas.length > 0, {
    message: 'informe ao menos um autor (parlamentar ou bancada)',
    path: ['autores'],
  });

const alteracao = z
  .object({
    versaoEsperada: z.number().int().min(1),
    numeroOficial: z.string().trim().min(1).max(60).nullable().optional(),
    tipo: z.enum(['individual', 'bancada']).optional(),
    objeto: texto.optional(),
    valorPropostoCentavos: centavos.optional(),
    autores: autores.optional(),
    bancadas: z.array(uuid).max(50).optional(),
  })
  .strict()
  .refine((v) => !v.autores || new Set(v.autores).size === v.autores.length, {
    message: 'autores repetidos',
    path: ['autores'],
  })
  .refine((v) => !v.bancadas || new Set(v.bancadas).size === v.bancadas.length, {
    message: 'bancadas repetidas',
    path: ['bancadas'],
  });

export function rotasEmendas(app: FastifyInstance, pool: Pool) {
  app.get('/emendas', async (req) => {
    const { exercicioId } = z.object({ exercicioId: uuid.optional() }).parse(req.query);
    return listarEmendas(pool, exercicioId);
  });

  app.get('/emendas/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const emenda = await buscarEmenda(pool, id);
    if (!emenda) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
    return emenda;
  });

  app.post('/emendas', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const dados = novaEmenda.parse(req.body);
    const emenda = await comTransacao(pool, ctx, (c) => criarEmenda(c, dados));
    return reply.status(201).send(emenda);
  });

  app.patch('/emendas/:id', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const dados = alteracao.parse(req.body);
    return comTransacao(pool, ctx, (c) => alterarEmenda(c, id, dados));
  });

  // Somente leitura: não existe rota para criar, alterar ou excluir eventos de auditoria.
  app.get('/emendas/:id/auditoria', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await buscarEmenda(pool, id))) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
    return listarAuditoriaDaEmenda(pool, id);
  });
}
