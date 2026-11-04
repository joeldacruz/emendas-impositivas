# Emendas Impositivas

Sistema de gestão de emendas impositivas municipais, inicialmente para a Câmara de Vereadores de Três Barras/SC.

**Fase atual: Fase 4 — emendas completas.** Núcleo funcional: exercício, parlamentar, mandatos, bancadas com composição histórica, emenda com autoria (parlamentar e/ou bancada), parâmetros legais versionados (sempre pendentes até validação) e auditoria. Os demais módulos do [roadmap](docs/05-plano-de-implementacao.md) ainda não foram implementados.

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
| `GET /emendas/:id/auditoria` | Eventos de auditoria da emenda (somente leitura) |

Valores monetários são **inteiros em centavos** (`valorPropostoCentavos`).

Exemplo:

```bash
curl -X POST http://127.0.0.1:3100/emendas \
  -H 'content-type: application/json' -H 'x-usuario: seu.nome' \
  -d '{"exercicioId":"<uuid>","tipo":"individual","objeto":"Exemplo","valorPropostoCentavos":134550,"autores":["<uuid>"]}'
```

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
  scripts/      migrate, seed-dev
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
| [docs/pendencias.md](docs/pendencias.md) | Lacunas e perguntas em aberto |

## Convenções

- Itens **PENDENTE DE VALIDAÇÃO** não viram regra de código sem conferência documentada.
- Não versionar arquivos reais da IPM nem dados pessoais reais.
- Segredos fora do repositório (`.env` é ignorado pelo Git).
