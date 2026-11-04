import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { comTransacao } from '../../db/transacao.js';
import { contextoDeAuditoria } from '../../http/contexto.js';
import { ErroNegocio } from '../../http/erros.js';
import {
  adicionarBeneficiario,
  adicionarIdentificadorExterno,
  alterarEmenda,
  buscarEmenda,
  criarEmenda,
  listarAuditoriaDaEmenda,
  listarEmendas,
  mudarSituacao,
  removerBeneficiario,
  removerIdentificadorExterno,
} from './repositorio.js';

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

  const versao = z.object({ versaoEsperada: z.number().int().min(1) }).strict();

  app.post('/emendas/:id/cadastrar', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { versaoEsperada } = versao.parse(req.body);
    return comTransacao(pool, ctx, (c) => mudarSituacao(c, id, versaoEsperada, 'cadastrada'));
  });

  // Cancelamento lógico: irreversível, exige motivo; a emenda e o histórico permanecem.
  app.post('/emendas/:id/cancelar', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({ versaoEsperada: z.number().int().min(1), motivo: z.string().trim().min(3).max(2000) })
      .strict()
      .parse(req.body);
    return comTransacao(pool, ctx, (c) => mudarSituacao(c, id, d.versaoEsperada, 'cancelada', d.motivo));
  });

  app.post('/emendas/:id/beneficiarios', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z.object({ beneficiarioId: uuid, valorCentavos: centavos.nullish() }).strict().parse(req.body);
    const e = await comTransacao(pool, ctx, (c) => adicionarBeneficiario(c, id, d.beneficiarioId, d.valorCentavos ?? null));
    return reply.status(201).send(e);
  });

  app.delete('/emendas/:id/beneficiarios/:beneficiarioId', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id, beneficiarioId } = z.object({ id: uuid, beneficiarioId: uuid }).parse(req.params);
    return comTransacao(pool, ctx, (c) => removerBeneficiario(c, id, beneficiarioId));
  });

  app.post('/emendas/:id/identificadores-externos', async (req, reply) => {
    const ctx = contextoDeAuditoria(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = z
      .object({
        sistema: z.string().trim().min(1).max(60),
        tipoId: z.string().trim().min(1).max(60),
        valorId: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    const e = await comTransacao(pool, ctx, (c) => adicionarIdentificadorExterno(c, id, d));
    return reply.status(201).send(e);
  });

  app.delete('/emendas/:id/identificadores-externos/:identificadorId', async (req) => {
    const ctx = contextoDeAuditoria(req);
    const { id, identificadorId } = z.object({ id: uuid, identificadorId: uuid }).parse(req.params);
    return comTransacao(pool, ctx, (c) => removerIdentificadorExterno(c, id, identificadorId));
  });

  // Somente leitura: não existe rota para criar, alterar ou excluir eventos de auditoria.
  app.get('/emendas/:id/auditoria', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!(await buscarEmenda(pool, id))) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
    return listarAuditoriaDaEmenda(pool, id);
  });
}
