import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../src/config/env.js';

describe('carregarConfig', () => {
  it('aplica padrões e aceita DATABASE_URL válida', () => {
    const c = carregarConfig({ DATABASE_URL: 'postgres://u:p@localhost:5433/db' });
    expect(c).toMatchObject({ AMBIENTE: 'desenvolvimento', PORT: 3100, HOST: '127.0.0.1', LOG_LEVEL: 'info' });
  });

  it('converte PORT numérica', () => {
    expect(carregarConfig({ DATABASE_URL: 'postgresql://x/y', PORT: '8080' }).PORT).toBe(8080);
  });

  it('falha sem DATABASE_URL', () => {
    expect(() => carregarConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejeita URL que não é PostgreSQL, ambiente desconhecido e porta inválida', () => {
    expect(() => carregarConfig({ DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
    expect(() => carregarConfig({ DATABASE_URL: 'postgres://x/y', AMBIENTE: 'qa' })).toThrow(/AMBIENTE/);
    expect(() => carregarConfig({ DATABASE_URL: 'postgres://x/y', PORT: '70000' })).toThrow(/PORT/);
  });
});
