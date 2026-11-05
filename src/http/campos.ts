import { z } from 'zod';

export const uuid = z.string().uuid();

/** Data civil AAAA-MM-DD, validada de verdade (rejeita 2026-02-30). */
export const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'data inválida');
