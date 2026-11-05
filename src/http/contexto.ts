import type { FastifyRequest } from 'fastify';
import type { ContextoAuditoria } from '../db/transacao.js';
import { ErroNegocio } from './erros.js';

/**
 * PROVISÓRIO: ainda não há autenticação. Enquanto ela não existir, escritas exigem o
 * cabeçalho X-Usuario, apenas para atribuição na auditoria. NÃO é controle de acesso.
 */
export function contextoDeAuditoria(req: FastifyRequest): ContextoAuditoria {
  const bruto = req.headers['x-usuario'];
  const usuario = (Array.isArray(bruto) ? bruto[0] : bruto)?.trim();
  if (!usuario || usuario.length > 120) {
    throw new ErroNegocio(400, 'usuario_obrigatorio', 'Informe o cabeçalho X-Usuario (1 a 120 caracteres)');
  }
  return { usuario, origem: 'api' };
}
