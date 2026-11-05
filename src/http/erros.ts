import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class ErroNegocio extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

interface ErroPg {
  code?: string;
  constraint?: string;
}

export function tratarErro(erro: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (erro instanceof ErroNegocio) {
    return reply.status(erro.status).send({ erro: erro.codigo, mensagem: erro.message });
  }
  if (erro instanceof ZodError) {
    return reply.status(400).send({
      erro: 'requisicao_invalida',
      mensagem: 'Dados inválidos',
      detalhes: erro.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })),
    });
  }
  const pg = erro as ErroPg;
  switch (pg.code) {
    case '23505':
      return reply.status(409).send({ erro: 'conflito', mensagem: 'Registro duplicado', restricao: pg.constraint });
    case '23503':
      return reply
        .status(422)
        .send({ erro: 'referencia_invalida', mensagem: 'Referência inexistente', restricao: pg.constraint });
    case '23514':
    case '22P02':
      return reply.status(422).send({ erro: 'dado_invalido', mensagem: 'Dado viola regra de integridade' });
    default:
  }
  if ('statusCode' in erro && typeof erro.statusCode === 'number' && erro.statusCode < 500) {
    return reply.status(erro.statusCode).send({ erro: 'requisicao_invalida', mensagem: erro.message });
  }
  req.log.error({ err: erro }, 'erro não tratado');
  return reply.status(500).send({ erro: 'erro_interno', mensagem: 'Erro interno' });
}
