/* eslint-disable no-console */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { carregarConfig } from '../config/env.js';
import { criarPool } from '../db/pool.js';
import { ErroFormato } from '../modules/financeiro/formato.js';
import { importarLote } from '../modules/financeiro/importador.js';

const USO = `Uso: npm run importar -- <arquivo.json> --usuario <nome> [--somente-validar] [--json]

Importa um lote SIMULADO (formato interno v1) para o banco local.
  --usuario          quem está importando (vai para a trilha de auditoria) — obrigatório
  --somente-validar  executa tudo e desfaz: mostra o resultado sem gravar nada
  --json             imprime o relatório completo em JSON`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { usuario: { type: 'string' }, 'somente-validar': { type: 'boolean' }, json: { type: 'boolean' }, ajuda: { type: 'boolean' } },
});

if (values.ajuda || positionals.length !== 1 || !values.usuario?.trim()) {
  console.error(USO);
  process.exit(values.ajuda ? 0 : 1);
}

const config = carregarConfig();
if (config.AMBIENTE === 'producao') {
  console.error('Importação recusada: esta fase só importa dados SIMULADOS em AMBIENTE=desenvolvimento ou teste.');
  process.exit(1);
}

const arquivo = positionals[0]!;
const bruto = await readFile(arquivo);
let conteudo: unknown;
try {
  conteudo = JSON.parse(bruto.toString('utf8'));
} catch (e) {
  console.error(`Arquivo não é JSON válido: ${(e as Error).message}`);
  process.exit(1);
}

const pool = criarPool(config.DATABASE_URL);
try {
  const rel = await importarLote(pool, conteudo, {
    usuario: values.usuario!.trim(),
    arquivoNome: basename(arquivo),
    arquivoSha256: createHash('sha256').update(bruto).digest('hex'),
    somenteValidar: values['somente-validar'] ?? false,
  });
  if (values.json) {
    console.log(JSON.stringify(rel, null, 2));
  } else {
    console.log(`${rel.simulacao ? '[SIMULAÇÃO — nada foi gravado] ' : ''}Lote ${rel.loteId}`);
    console.log(`Origem ${rel.origem} | exercício ${rel.exercicio} | UG ${rel.unidadeGestora} | referência ${rel.dataReferencia}`);
    const t = rel.totais;
    console.log(
      `Linhas ${t.linhas}: aceitas ${t.aceitas}, já importadas ${t.jaImportadas}, divergentes ${t.divergentes}, rejeitadas ${t.rejeitadas} | sem vínculo ${t.semVinculo}`,
    );
    for (const l of rel.linhas) {
      console.log(`  #${l.numeroLinha} ${l.tipo ?? '?'} ${l.chaveOrigem ?? '?'} => ${l.resultado}${l.semVinculo ? ' (sem vínculo)' : ''}`);
      for (const m of l.motivos) console.log(`       - ${m}`);
    }
  }
} catch (e) {
  if (e instanceof ErroFormato) {
    console.error('Lote recusado (nada foi gravado):');
    for (const m of e.motivos) console.error(`  - ${m}`);
    process.exitCode = 2;
  } else {
    throw e;
  }
} finally {
  await pool.end();
}
