/* eslint-disable no-console */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { carregarConfig } from '../config/env.js';
import { criarPool } from '../db/pool.js';
import { ErroNegocio } from '../http/erros.js';
import { consultarExecucaoDaEmenda } from '../modules/financeiro/consulta.js';
import {
  listarMovimentos,
  listarPendencias,
  resolverPendenciaDeDivergencia,
  revogarVinculo,
  vincularMovimento,
} from '../modules/financeiro/vinculos.js';

const USO = `Uso: npm run financeiro -- <comando> [opções]

Comandos (dados SIMULADOS, banco local):
  pendencias [--todas]                    lista pendências (padrão: só abertas)
  movimentos [--sem-vinculo]              lista movimentos e o saldo ainda não alocado
  consulta --emenda <id>                  execução financeira vinculada a uma emenda
  vincular --movimento <id> --emenda <id> [--valor <centavos>] --justificativa <texto> --usuario <nome>
                                          vincula (ou ratea) um movimento; sem --valor, aloca todo o saldo livre
  revogar --vinculo <id> --motivo <texto> --usuario <nome>
  resolver --pendencia <id> --resolucao <texto> --usuario <nome>
                                          encerra pendência de divergência após conferência`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    todas: { type: 'boolean' },
    'sem-vinculo': { type: 'boolean' },
    emenda: { type: 'string' },
    movimento: { type: 'string' },
    vinculo: { type: 'string' },
    pendencia: { type: 'string' },
    valor: { type: 'string' },
    justificativa: { type: 'string' },
    motivo: { type: 'string' },
    resolucao: { type: 'string' },
    usuario: { type: 'string' },
  },
});

const comando = positionals[0];
const config = carregarConfig();
if (config.AMBIENTE === 'producao') {
  console.error('Comando recusado: esta fase só opera dados SIMULADOS em AMBIENTE=desenvolvimento ou teste.');
  process.exit(1);
}
const exigir = (v: string | undefined, nome: string): string => {
  if (!v?.trim()) {
    console.error(`Informe --${nome}\n\n${USO}`);
    process.exit(1);
  }
  return v.trim();
};
const imprimir = (x: unknown) => console.log(JSON.stringify(x, null, 2));

const pool = criarPool(config.DATABASE_URL);
try {
  switch (comando) {
    case 'pendencias':
      imprimir(await listarPendencias(pool, { todas: values.todas ?? false }));
      break;
    case 'movimentos':
      imprimir(await listarMovimentos(pool, { semVinculo: values['sem-vinculo'] ?? false }));
      break;
    case 'consulta': {
      const r = await consultarExecucaoDaEmenda(pool, exigir(values.emenda, 'emenda'));
      if (!r) throw new ErroNegocio(404, 'nao_encontrada', 'Emenda não encontrada');
      imprimir(r);
      break;
    }
    case 'vincular': {
      const valor = values.valor === undefined ? undefined : Number(values.valor);
      if (valor !== undefined && (!Number.isSafeInteger(valor) || valor <= 0)) {
        throw new ErroNegocio(400, 'valor_invalido', '--valor deve ser inteiro positivo (centavos)');
      }
      const usuario = exigir(values.usuario, 'usuario');
      imprimir(
        await vincularMovimento(
          pool,
          { usuario, origem: 'cli-financeiro' },
          {
            movimentoId: exigir(values.movimento, 'movimento'),
            emendaId: exigir(values.emenda, 'emenda'),
            ...(valor !== undefined ? { valorCentavos: valor } : {}),
            justificativa: exigir(values.justificativa, 'justificativa'),
          },
        ),
      );
      break;
    }
    case 'revogar': {
      const usuario = exigir(values.usuario, 'usuario');
      imprimir(
        await revogarVinculo(pool, { usuario, origem: 'cli-financeiro' }, { vinculoId: exigir(values.vinculo, 'vinculo'), motivo: exigir(values.motivo, 'motivo') }),
      );
      break;
    }
    case 'resolver': {
      const usuario = exigir(values.usuario, 'usuario');
      imprimir(
        await resolverPendenciaDeDivergencia(
          pool,
          { usuario, origem: 'cli-financeiro' },
          { pendenciaId: exigir(values.pendencia, 'pendencia'), resolucao: exigir(values.resolucao, 'resolucao') },
        ),
      );
      break;
    }
    default:
      console.error(USO);
      process.exitCode = comando ? 1 : 0;
  }
} catch (e) {
  if (e instanceof ErroNegocio) {
    console.error(`Erro (${e.codigo}): ${e.message}`);
    process.exitCode = 2;
  } else {
    throw e;
  }
} finally {
  await pool.end();
}
