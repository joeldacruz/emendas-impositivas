import { z } from 'zod';

const esquema = z.object({
  AMBIENTE: z.enum(['desenvolvimento', 'teste', 'producao']).default('desenvolvimento'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL é obrigatória' })
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL deve começar com postgres:// ou postgresql://'),
});

export type Config = z.infer<typeof esquema>;

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const resultado = esquema.safeParse(env);
  if (!resultado.success) {
    const detalhes = resultado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${detalhes}`);
  }
  return resultado.data;
}
