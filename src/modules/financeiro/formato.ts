import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dataIso } from '../../http/campos.js';

/**
 * Formato interno de importação da execução orçamentária e financeira — versão 1.
 *
 * É um formato NOSSO. Não é, e não deve ser tomado como, layout oficial da IPM/Atende.Net.
 * Quando houver contrato de dados confirmado, um conector traduzirá a origem para este formato (ou para a
 * versão seguinte dele). Documentação: docs/integracao-ipm/formato-importacao-v1.md.
 */
export const FORMATO_ID = 'emendas-impositivas/importacao-financeira';
export const FORMATO_VERSAO = 1;

export const TIPOS = ['empenho', 'liquidacao', 'pagamento', 'estorno_liquidacao', 'estorno_pagamento'] as const;
export type TipoMovimento = (typeof TIPOS)[number];

/** Tipo do registro pai exigido por cada tipo (empenho não tem pai). */
export const TIPO_DO_PAI: Record<TipoMovimento, TipoMovimento | null> = {
  empenho: null,
  liquidacao: 'empenho',
  pagamento: 'liquidacao',
  estorno_liquidacao: 'liquidacao',
  estorno_pagamento: 'pagamento',
};

export class ErroFormato extends Error {
  constructor(public readonly motivos: string[]) {
    super(`Lote rejeitado: ${motivos.join('; ')}`);
  }
}

const texto = (max: number) => z.string().trim().min(1).max(max);

const cabecalhoEsquema = z
  .object({
    formato: z.literal(FORMATO_ID, { error: `formato deve ser "${FORMATO_ID}"` }),
    versao: z.literal(FORMATO_VERSAO, { error: `versao deve ser ${FORMATO_VERSAO}` }),
    origem: z
      .string()
      .regex(/^SIMULADO-[A-Z0-9-]{1,40}$/, 'origem deve começar com "SIMULADO-" (nesta fase só dados simulados)'),
    exercicio: z.number().int().min(1990).max(2100),
    unidadeGestora: texto(60),
    dataReferencia: dataIso,
    registros: z.array(z.unknown()).max(20000, 'no máximo 20000 registros por lote'),
  })
  .strict();

export interface Cabecalho {
  origem: string;
  exercicio: number;
  unidadeGestora: string;
  dataReferencia: string;
  registros: unknown[];
}

const formatarIssues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);

export function validarCabecalho(bruto: unknown): Cabecalho {
  const r = cabecalhoEsquema.safeParse(bruto);
  if (!r.success) throw new ErroFormato(formatarIssues(r.error));
  return r.data;
}

const registroEsquema = z
  .object({
    tipo: z.enum(TIPOS, { error: `tipo deve ser um de: ${TIPOS.join(', ')}` }),
    chaveOrigem: texto(120),
    registroPaiChave: texto(120).nullish(),
    numero: texto(60).nullish(),
    exercicioDocumento: z.number().int().min(1990).max(2100).nullish(),
    dataDocumento: dataIso,
    valorCentavos: z.number({ error: 'valorCentavos deve ser inteiro (centavos)' }).int('valorCentavos deve ser inteiro (centavos)').positive('valorCentavos deve ser positivo').max(Number.MAX_SAFE_INTEGER),
    dotacao: texto(200).nullish(),
    credorNome: texto(200).nullish(),
    identificadorEmenda: texto(200).nullish(),
  })
  .strict();

export interface RegistroValido {
  tipo: TipoMovimento;
  chaveOrigem: string;
  registroPaiChave: string | null;
  numero: string | null;
  exercicioDocumento: number | null;
  dataDocumento: string;
  valorCentavos: number;
  dotacao: string | null;
  credorNome: string | null;
  identificadorEmenda: string | null;
}

/** Valida um registro isolado. Devolve o registro normalizado ou a lista de motivos de rejeição. */
export function validarRegistro(bruto: unknown): { ok: true; registro: RegistroValido } | { ok: false; motivos: string[] } {
  if (bruto === null || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return { ok: false, motivos: ['registro deve ser um objeto'] };
  }
  const r = registroEsquema.safeParse(bruto);
  if (!r.success) return { ok: false, motivos: formatarIssues(r.error) };
  const d = r.data;
  const registro: RegistroValido = {
    tipo: d.tipo,
    chaveOrigem: d.chaveOrigem,
    registroPaiChave: d.registroPaiChave ?? null,
    numero: d.numero ?? null,
    exercicioDocumento: d.exercicioDocumento ?? null,
    dataDocumento: d.dataDocumento,
    valorCentavos: d.valorCentavos,
    dotacao: d.dotacao ?? null,
    credorNome: d.credorNome ?? null,
    identificadorEmenda: d.identificadorEmenda ?? null,
  };
  const motivos: string[] = [];
  if (TIPO_DO_PAI[registro.tipo] === null && registro.registroPaiChave !== null) {
    motivos.push('registroPaiChave: empenho não tem registro pai');
  }
  if (TIPO_DO_PAI[registro.tipo] !== null && registro.registroPaiChave === null) {
    motivos.push(`registroPaiChave: ${registro.tipo} exige o registro pai (${TIPO_DO_PAI[registro.tipo]})`);
  }
  return motivos.length ? { ok: false, motivos } : { ok: true, registro };
}

/** Campos que compõem o conteúdo comparável (a chave de origem fica de fora: é a identidade). */
export const CAMPOS_DO_CONTEUDO = [
  'tipo',
  'registroPaiChave',
  'numero',
  'exercicioDocumento',
  'dataDocumento',
  'valorCentavos',
  'dotacao',
  'credorNome',
  'identificadorEmenda',
] as const;

export function conteudoCanonico(r: RegistroValido): Record<(typeof CAMPOS_DO_CONTEUDO)[number], string | number | null> {
  const saida = {} as Record<(typeof CAMPOS_DO_CONTEUDO)[number], string | number | null>;
  for (const campo of CAMPOS_DO_CONTEUDO) saida[campo] = r[campo];
  return saida;
}

/** SHA-256 do conteúdo normalizado, em ordem fixa de campos: mesmo conteúdo => mesmo hash. */
export function hashDoConteudo(r: RegistroValido): string {
  return createHash('sha256').update(JSON.stringify(conteudoCanonico(r))).digest('hex');
}
