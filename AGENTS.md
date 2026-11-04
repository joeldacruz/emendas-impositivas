# AGENTS.md — instruções para agentes de código

Projeto **Emendas Impositivas** da Câmara de Vereadores de Três Barras/SC: gestão de emendas
parlamentares municipais. Leia este arquivo, o [README](README.md) e [docs/pendencias.md](docs/pendencias.md)
antes de alterar qualquer coisa. O estado real do projeto (o que existe e o que não existe) está no README e no
plano de implementação; **não presuma funcionalidades que não estejam lá**.

## Escopo e limites

- Toda a gestão das emendas vive **neste sistema**. É um monólito modular (`src/modules/*`), sem microsserviços.
- **IPM/Atende.Net** é a fonte contábil oficial. A integração prevista é **somente leitura** (consulta/importação
  de execução orçamentária e financeira). Nunca escrever no banco da IPM. **Não inventar** endpoints, credenciais,
  autenticação ou layouts: o contrato proposto está em [docs/investigacao-ipm.md](docs/investigacao-ipm.md) e depende
  de resposta da IPM. Não há integração implementada.
- **Empenho liquidado, empenho pago, objeto entregue e prestação de contas aprovada não são equivalentes.**
  Nunca tratar um como sinônimo de outro, em modelo, código, texto ou relatório.
- **Regras jurídicas não validadas não podem ser implementadas** (percentuais de 2% / metade para saúde / até 1%
  para bancadas, prazos, bloqueios). Ficam registradas como `PENDENTE DE VALIDAÇÃO`
  ([matriz](docs/juridico/matriz-requisitos-juridicos.md)). Os parâmetros legais entram no sistema como dados
  versionados e só valem depois de validados por pessoa identificada. A tramitação atual é **neutra** (etapas,
  responsáveis e prazos informados por quem opera).
- O briefing original ficou truncado em "Regras versionadas por exercício e…"; o restante não foi informado
  (registrado em `docs/pendencias.md`). Não complete por suposição.

## Limitações atuais (não esconder, não contornar)

- **Sem autenticação**: o cabeçalho `X-Usuario` é provisório, só identifica o autor na auditoria. Não é segurança.
- Sem papéis/permissões, sem papéis de banco separados, sem armazenamento de arquivos (só metadados e SHA-256),
  sem deploy/produção. `docker compose` ainda não foi validado em máquina real.
- Nenhum arquivo real da IPM, do portal ou de terceiros é baixado ou versionado. Dados de desenvolvimento são
  fictícios (`[FICTÍCIO]`) e o seed é bloqueado em `AMBIENTE=producao`.

## Fluxo de trabalho

- Branches `feat/*` / `fix/*`, PRs pequenos. **Não fazer merge, deploy nem force-push sem pedido explícito do
  responsável.** PRs empilhados: preserve a cadeia (cada base é o branch anterior).
- Commits em português, no formato `tipo: resumo` (`feat`, `fix`, `docs`, `chore`).
- Registre decisões relevantes em `docs/adr/` e pendências em `docs/pendencias.md`. Atualize o README quando
  mudar endpoint, comando ou comportamento.
- Não registre segredos. `.env` nunca é versionado; `.env.example` só tem valores de exemplo.

## Comandos

```bash
npm ci
cp .env.example .env     # ajuste se necessário
docker compose up -d     # PostgreSQL (banco de desenvolvimento e de teste)
npm run migrate          # aplica db/migrations
npm run seed             # dados FICTÍCIOS (somente desenvolvimento)
npm run dev              # API com recarga
npm run check            # tipos + lint + testes (PostgreSQL real) + build
```

Os testes exigem `TEST_DATABASE_URL` e criam um schema isolado por arquivo. Antes de entregar rode
`npm run check` e `git diff --check`.

## Regras de código

- TypeScript estrito, Node 22+, Fastify, `pg` com **SQL explícito** (sem ORM), validação com zod.
- **Dinheiro em centavos inteiros** (`bigint` no banco). Nunca `float`.
- **Migrações são append-only**: `db/migrations/NNNN_*.sql`, com checksum. Nunca reescreva uma migração já
  aplicada ou publicada; corrija com uma migração nova (`CREATE OR REPLACE FUNCTION`, `ALTER`…).
- **Integridade no banco**, não só na API: restrições, gatilhos e travas valem também para quem acessa o banco
  direto. Cuidado com concorrência: trave a linha da emenda antes de ler valores que dependem dela.
- **Auditoria**: toda tabela de negócio tem gatilho `auditoria_registrar`; `auditoria_evento` é append-only
  (sem UPDATE/DELETE/TRUNCATE) e todo evento deve ter `emenda_id` quando pertencer a uma emenda — inclusive
  tabelas filhas indiretas (resolva pela cadeia de chaves). Alterações passam por `comTransacao`, que define
  usuário e origem. Registros permanentes não são apagados; correção é cancelamento/substituição.
- Emenda tem `id` imutável e `versao` (controle otimista: PATCH exige `versaoEsperada`); cancelamento é lógico.
- Testes novos para persistência/integridade usam PostgreSQL real; para concorrência, reproduza o cenário em
  transações cruzadas, não só em chamadas sequenciais.
