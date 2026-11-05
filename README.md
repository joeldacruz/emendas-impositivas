# Emendas Impositivas

Sistema de gestão de emendas impositivas municipais, inicialmente para a Câmara de Vereadores de Três Barras/SC.

**Fase atual: Fase 6A — importação financeira SIMULADA (sem conexão com a IPM).** Antes: Fase 5 — planos, tramitação, pareceres e documentos. Núcleo funcional: exercício, parlamentar, mandatos, bancadas com composição histórica, emenda com autoria (parlamentar e/ou bancada), parâmetros legais versionados (sempre pendentes até validação) e auditoria. Os demais módulos do [roadmap](docs/05-plano-de-implementacao.md) ainda não foram implementados.

## Diretriz

- Toda a gestão das emendas é feita **neste sistema**.
- A integração com **IPM/Atende.Net** se limita à **consulta/importação** da execução orçamentária e financeira. A IPM continua sendo a fonte oficial dos registros contábeis; nunca se escreve no banco dela.
- Nada aqui presume API, autenticação, layout ou acesso da IPM.
- Parâmetros jurídicos (percentuais, limites, prazos, bloqueios) estão **PENDENTES DE VALIDAÇÃO** e **não** foram implementados. A API só *registra* parâmetros e seu estado de validação; nenhuma rota os usa para calcular, limitar ou bloquear. Nenhum valor jurídico real é semeado.

## O que já funciona

- API HTTP (Fastify + TypeScript) com `GET /saude`, cadastros mínimos e CRUD parcial de emendas.
- PostgreSQL com migrações SQL versionadas e verificação de checksum.
- Auditoria de criação, alteração e remoção de emendas e autorias, gravada por gatilhos do banco, append-only e sem rota de escrita na API.
- Controle otimista de versão nas alterações.
- Dados fictícios para desenvolvimento, que se recusam a rodar fora de `AMBIENTE=desenvolvimento`.

## Requisitos

- Node.js 22 ou superior e npm.
- PostgreSQL 16: via Docker (`docker compose`) ou instalação própria.

## Execução local

```bash
git clone https://github.com/joeldacruz/emendas-impositivas.git
cd emendas-impositivas
npm ci
cp .env.example .env
```

Suba o PostgreSQL de desenvolvimento (porta local 5433; cria os bancos `emendas_dev` e `emendas_test`):

```bash
docker compose up -d
```

Sem Docker, use um PostgreSQL 16 próprio, crie os bancos `emendas_dev` e `emendas_test` e ajuste `DATABASE_URL` e `TEST_DATABASE_URL` no `.env`.

Aplique as migrações, carregue os dados fictícios e inicie a API:

```bash
npm run migrate
npm run seed
npm run dev
```

A API sobe em `http://127.0.0.1:3100`. Teste:

```bash
curl http://127.0.0.1:3100/saude
curl http://127.0.0.1:3100/emendas
```

## Uso da API

Escritas exigem o cabeçalho `X-Usuario` (provisório, só para atribuir a auditoria; **não é autenticação**).

| Método e rota | Descrição |
|---|---|
| `GET /saude` | Estado da aplicação e do banco (503 se o banco estiver indisponível) |
| `GET/POST /exercicios` | Lista / cria exercício |
| `GET/POST /parlamentares` | Lista / cria parlamentar |
| `GET/POST /parlamentares/:id/mandatos` | Mandatos; sobreposição para o mesmo parlamentar é recusada (409) |
| `GET/POST /bancadas` | Lista / cria bancada (nome único por exercício) |
| `GET/POST /bancadas/:id/membros` | Vínculos com vigência (datas inclusivas, `AAAA-MM-DD`) |
| `PATCH /bancadas/:id/membros/:membroId` | Só encerra a vigência (`vigenciaFim`); histórico não é reescrito |
| `GET /bancadas/:id/composicao?data=` | Composição da bancada em uma data |
| `GET/POST /fontes-normativas` | Fontes normativas (lei, decreto etc.) |
| `GET/POST /parametros-legais` | Parâmetros versionados; nascem `PENDENTE`; filtros `exercicioId`, `codigo`, `data` |
| `POST /parametros-legais/:id/validacao` | Muda o status; `VALIDADO` exige fonte normativa e registra validador e data |
| `POST /parametros-legais/:id/encerrar` | Encerra a vigência (única edição permitida; valor é imutável) |
| `GET /emendas?exercicioId=` | Lista emendas |
| `POST /emendas` | Cria emenda com autoria: `autores` (parlamentares) e/ou `bancadas`, ao menos um |
| `GET /emendas/:id` | Lê emenda |
| `PATCH /emendas/:id` | Altera emenda; exige `versaoEsperada` (409 se desatualizada) |
| `GET/POST /beneficiarios`, `GET /beneficiarios/:id` | Beneficiários; `documento` só dígitos (CPF 11 / CNPJ 14), dado pessoal restrito à área interna |
| `POST /emendas/:id/beneficiarios`, `DELETE .../:beneficiarioId` | Vincula/remove beneficiário com `valorCentavos` opcional; a soma não pode passar do valor proposto |
| `POST /emendas/:id/identificadores-externos`, `DELETE .../:identificadorId` | Identificadores de outros sistemas (ex.: IPM), separados do ID interno e do número oficial |
| `POST /emendas/:id/cadastrar` | `rascunho` → `cadastrada` (exige `versaoEsperada`) |
| `POST /emendas/:id/cancelar` | Cancelamento lógico com `motivo`; irreversível; emenda cancelada fica congelada |
| `GET/POST /emendas/:id/planos-trabalho`, `GET /planos-trabalho/:id` | Planos versionados (1, 2, 3…) com metas, itens e marcos; totais exatos em centavos |
| `POST /planos-trabalho/:id/metas`, `POST /metas/:id/itens`, `POST /itens/:id/marcos` | Montagem do plano em rascunho (`DELETE /metas|itens|marcos/:id` também só em rascunho) |
| `POST /planos-trabalho/:id/ativar` | Ativa (exige itens e total ≤ valor da emenda), congela o conteúdo e marca o vigente anterior como `substituido` |
| `PATCH /marcos/:id` | Registra a data realizada de um marco (única edição permitida em plano vigente) |
| `GET/POST /emendas/:id/tramitacao`, `POST /tramitacao/:id/concluir\|cancelar` | Etapas livres com responsável e prazo informados; `?referencia=AAAA-MM-DD` calcula `atrasada` |
| `GET/POST /emendas/:id/pareceres` | Pareceres permanentes (nova opinião = novo parecer) |
| `GET/POST /emendas/:id/diligencias`, `POST /diligencias/:id/atender\|cancelar` | Diligências; encerrar exige resposta/motivo |
| `GET/POST /emendas/:id/documentos`, `POST /documentos/:id/classificacao` | Metadados de documentos (nome, tipo, tamanho, SHA-256); nasce `interno`; publicar exige justificativa |
| `GET /emendas/:id/auditoria` | Eventos de auditoria da emenda (somente leitura) |

Valores monetários são **inteiros em centavos** (`valorPropostoCentavos`).

Exemplo:

```bash
curl -X POST http://127.0.0.1:3100/emendas \
  -H 'content-type: application/json' -H 'x-usuario: seu.nome' \
  -d '{"exercicioId":"<uuid>","tipo":"individual","objeto":"Exemplo","valorPropostoCentavos":134550,"autores":["<uuid>"]}'
```

## Importação financeira simulada (Fase 6A)

Núcleo de importação da execução orçamentária e financeira, **só com dados fictícios** e **sem qualquer conexão com a IPM**. O formato é nosso ([formato-importacao-v1](docs/integracao-ipm/formato-importacao-v1.md)), não um layout oficial. A carga e as decisões de vínculo são feitas por **comando local** (não há rota de escrita, pois a autenticação ainda está pendente); a API só tem a consulta por emenda, somente leitura. O banco recusa lotes cuja origem não comece com `SIMULADO-`, e os comandos recusam `AMBIENTE=producao`.

Fluxo completo (use os arquivos de [exemplos/importacao-financeira](exemplos/importacao-financeira)):

```bash
npm run migrate && npm run seed                       # cria a emenda FICT-001 com o identificador FIC-EMD-001
npm run importar -- exemplos/importacao-financeira/lote-ficticio-01.json --usuario seu.nome
npm run importar -- exemplos/importacao-financeira/lote-ficticio-01.json --usuario seu.nome   # reimportação: nada duplica
npm run importar -- exemplos/importacao-financeira/lote-ficticio-02-com-problemas.json --usuario seu.nome   # rejeições, divergência, sem vínculo
npm run importar -- <arquivo> --usuario seu.nome --somente-validar   # roda tudo e desfaz (nada é gravado)
```

```bash
npm run financeiro -- pendencias                      # pendências abertas (divergência de origem e movimento sem vínculo)
npm run financeiro -- movimentos --sem-vinculo        # movimentos com saldo não alocado
npm run financeiro -- vincular --movimento <id> --emenda <id> [--valor <centavos>] --justificativa "..." --usuario seu.nome
npm run financeiro -- revogar --vinculo <id> --motivo "..." --usuario seu.nome
npm run financeiro -- resolver --pendencia <id> --resolucao "..." --usuario seu.nome   # só divergência, após conferência
npm run financeiro -- consulta --emenda <id>          # o mesmo que a rota abaixo
curl http://127.0.0.1:3100/emendas/<id>/execucao-financeira
```

Regras principais:

- **Escopo da chave:** `(origem, exercício, unidade gestora, chaveOrigem)`; a mesma chave em outro exercício ou unidade é outro movimento.
- **Idempotência:** mesma chave e mesmo conteúdo (SHA-256 do conteúdo normalizado) = ignorado. Mesma chave com conteúdo diferente = o registro anterior é **preservado** e abre-se pendência de conferência (uma só por conteúdo divergente).
- **Rejeição por linha, com motivo:** formato, tipo, pai inexistente ou de tipo errado, datas incoerentes (inclusive movimento posterior à data de referência do lote, checado antes de decidir se é duplicata) e saldos da cadeia (liquidação ≤ empenho; pagamento ≤ liquidação líquida; estornos ≤ original). As demais linhas do lote são consolidadas.
- **Ordem do lote:** o formato não traz sequência de lançamento e ela não é inventada: processa-se por `dataDocumento` e, no empate, pela posição no arquivo; linha rejeitada só por dependência (pai ou saldo) é reavaliada depois das demais. Assim um estorno válido libera saldo para uma reposição no mesmo lote. Disputa pelo mesmo saldo: vale a de menor (data, posição), a outra é rejeitada com motivo.
- **Vínculo com emenda:** automático **somente** pelo `identificadorEmenda` previamente cadastrado como identificador externo (`sistema = origem`, `tipoId = emenda`); nunca por credor ou coincidência de valores. Sem vínculo, o movimento fica **pendente**. Vínculo manual exige justificativa; rateio entre emendas com soma ≤ valor do movimento (garantido no banco, inclusive sob concorrência); vínculo errado é revogado, nunca apagado. **Estorno só abate a parcela do original alocada à mesma emenda** (sem alocação compatível: o estorno fica sem vínculo e a emenda afetada recebe uma pendência); revogar o vínculo do original com estornos vinculados é bloqueado.
- **Última carga × referência dos dados:** a consulta traz `ultimaImportacao` (a última carga) e `referenciaMaisRecenteDosDados` (que não retrocede com uma carga histórica), além de `pendenciasAbertas` da emenda.
- **Estados distintos:** a consulta separa empenhado, liquidado e pago (brutos e líquidos de estornos) e traz `objetoEntregue` e `prestacaoDeContasAprovada` como **não apurados**: nada disso decorre de valores financeiros.
- **Auditoria:** lote, movimentos, pendências e vínculos geram eventos (usuário e origem); eventos de vínculo aparecem em `GET /emendas/:id/auditoria`.

Roteiro (núcleo simulado × conector real) e perguntas abertas sobre a rotina 45679: [investigacao-ipm](docs/integracao-ipm/investigacao-ipm.md) (seção "Fase 6") e [pendências](docs/pendencias.md) (itens 37 a 52).

## Testes e verificações

Os testes usam PostgreSQL real, cada arquivo num schema isolado e descartável dentro de `TEST_DATABASE_URL`. Nunca apontam para o banco de desenvolvimento.

```bash
npm run typecheck   # tipos
npm run lint        # ESLint
npm test            # Vitest (exige TEST_DATABASE_URL)
npm run build       # compila para dist/
npm run check       # tudo acima em sequência
```

`npm test` carrega `TEST_DATABASE_URL` do ambiente. Para usar o `.env`, exporte antes, por exemplo `export $(grep TEST_DATABASE_URL .env)`. O CI (GitHub Actions) roda tipos, lint, testes com PostgreSQL 16 e build em cada PR.

## Estrutura

```
src/
  config/       leitura e validação de variáveis de ambiente
  db/           pool, migrações, transação com contexto de auditoria, seed fictício
  http/         tratamento de erros e contexto do usuário
  modules/      emendas, cadastros, saude (monólito modular)
  scripts/      migrate, seed-dev, importar-financeiro, financeiro
exemplos/       lotes FICTÍCIOS de importação financeira
db/migrations/  SQL versionado (não edite arquivos já aplicados)
test/           testes de persistência, integridade, auditoria e API
docs/           fundação documental, ADRs e investigação IPM
```

## Produção

Esta fase **não inclui deploy**. Para produção: use `npm run build`, `npm run migrate:prod` e `npm start` com `AMBIENTE=producao` e credenciais próprias; o seed fictício é bloqueado nesse modo. Autenticação, papéis de banco e implantação ainda estão pendentes (ver [pendências](docs/pendencias.md)).

## Documentos

| Documento | Conteúdo |
|---|---|
| [docs/01-escopo.md](docs/01-escopo.md) | Escopo, fora de escopo, glossário e estados que não são equivalentes |
| [docs/02-arquitetura.md](docs/02-arquitetura.md) | Arquitetura proposta |
| [docs/03-modelo-de-dados.md](docs/03-modelo-de-dados.md) | Modelo de dados conceitual |
| [docs/04-requisitos.md](docs/04-requisitos.md) | Requisitos |
| [docs/05-plano-de-implementacao.md](docs/05-plano-de-implementacao.md) | Fases e critérios de aceite |
| [docs/investigacao-ipm.md](docs/investigacao-ipm.md) | Minuta de solicitação técnica à IPM e contrato de dados proposto (rascunho, nada enviado) |
| [docs/integracao-ipm/investigacao-ipm.md](docs/integracao-ipm/investigacao-ipm.md) | Evidências, hipóteses e roteiro da investigação |
| [docs/juridico/matriz-requisitos-juridicos.md](docs/juridico/matriz-requisitos-juridicos.md) | Matriz de validação jurídica |
| [docs/adr/0001-principios-tecnicos.md](docs/adr/0001-principios-tecnicos.md) | Princípios técnicos |
| [docs/adr/0002-stack-typescript-postgresql.md](docs/adr/0002-stack-typescript-postgresql.md) | Stack e monólito modular |
| [docs/adr/0003-importacao-financeira-simulada.md](docs/adr/0003-importacao-financeira-simulada.md) | Decisões do núcleo simulado de importação |
| [docs/integracao-ipm/formato-importacao-v1.md](docs/integracao-ipm/formato-importacao-v1.md) | Formato interno de importação (v1), resultados e exemplo |
| [docs/pendencias.md](docs/pendencias.md) | Lacunas e perguntas em aberto |

## Convenções

- Itens **PENDENTE DE VALIDAÇÃO** não viram regra de código sem conferência documentada.
- Não versionar arquivos reais da IPM nem dados pessoais reais.
- Segredos fora do repositório (`.env` é ignorado pelo Git).
