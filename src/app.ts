import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config/env.js';
import type { Pool } from './db/pool.js';
import { tratarErro } from './http/erros.js';
import { rotasBancadas } from './modules/bancadas/rotas.js';
import { rotasBeneficiarios } from './modules/beneficiarios/rotas.js';
import { rotasCadastros } from './modules/cadastros/rotas.js';
import { rotasDocumentos } from './modules/documentos/rotas.js';
import { rotasEmendas } from './modules/emendas/rotas.js';
import { rotasExecucaoFinanceira } from './modules/financeiro/consulta.js';
import { rotasPlanos } from './modules/planos/rotas.js';
import { rotasParametros } from './modules/parametros/rotas.js';
import { rotasSaude } from './modules/saude/rotas.js';
import { rotasTramitacao } from './modules/tramitacao/rotas.js';

export function construirApp(pool: Pool, config: Pick<Config, 'LOG_LEVEL' | 'AMBIENTE'>): FastifyInstance {
  const app = Fastify({
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL },
    bodyLimit: 256 * 1024,
  });
  app.setErrorHandler(tratarErro);
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ erro: 'nao_encontrada', mensagem: 'Rota inexistente' }));

  rotasSaude(app, pool, config.AMBIENTE);
  rotasCadastros(app, pool);
  rotasBancadas(app, pool);
  rotasBeneficiarios(app, pool);
  rotasParametros(app, pool);
  rotasEmendas(app, pool);
  rotasPlanos(app, pool);
  rotasTramitacao(app, pool);
  rotasDocumentos(app, pool);
  rotasExecucaoFinanceira(app, pool);
  return app;
}
