# ADR 0002 — Stack: TypeScript, Fastify e PostgreSQL em monólito modular

Status: **Aceito** (aprovado pelo responsável do projeto) · Data: 2026-11-04
Complementa o [ADR 0001](0001-principios-tecnicos.md).

## Decisão

- **Linguagem:** TypeScript (modo `strict`) sobre Node.js 22+.
- **Banco:** PostgreSQL 16.
- **Framework HTTP:** Fastify 5.
- **Arquitetura:** monólito modular — um único processo e um único banco, com módulos por domínio em `src/modules/`.
- **Migrações:** arquivos SQL versionados em `db/migrations/`, aplicados por um executor próprio de ~60 linhas (`src/db/migrar.ts`).
- **Acesso a dados:** driver `pg` com SQL explícito; sem ORM.
- **Validação:** `zod`, na borda HTTP e na leitura de configuração.
- **Testes:** Vitest contra PostgreSQL real; **lint:** ESLint + typescript-eslint.

## Por que Fastify

- Pequeno, estável e com validação/ciclo de vida de requisição bem definidos; fácil de ler por quem mantiver depois.
- `inject()` embutido permite testar a API completa sem abrir porta.
- Não impõe estrutura (como NestJS), o que evita camadas de injeção de dependência e decoradores num sistema que precisa de manutenção simples.
- Alternativas descartadas: **NestJS** (cerimônia e curva de aprendizado acima da necessidade); **Express** (sem validação nem tipos de primeira classe; ecossistema estagnado).

## Por que monólito modular

- Equipe pequena, domínio coeso, transações que cruzam emenda, autoria, rateio e auditoria: um único banco transacional é o caminho mais simples e correto.
- Módulos com fronteiras claras (`emendas`, `cadastros`, futuramente `financeiro`, `integracao-ipm`, `portal`) permitem separar depois, se for necessário, sem reescrever.
- Um único artefato para implantar e operar.

## Por que SQL explícito, sem ORM

- O modelo depende de recursos do banco (gatilhos de auditoria, restrições `CHECK`, `UNIQUE` parciais, `bigint` exato). Escrever o SQL torna esses pontos visíveis e revisáveis.
- Menos abstração para atualizar e depurar.

## Por que auditoria em gatilhos do banco

A auditoria é gravada por gatilhos `AFTER INSERT/UPDATE/DELETE`, não pelo código da aplicação. Assim, qualquer alteração, inclusive feita direto no banco, gera evento; é impossível "esquecer" de auditar numa rota nova. A aplicação informa usuário e origem por transação (`app.usuario`, `app.origem`). A tabela `auditoria_evento` é append-only (gatilhos barram `UPDATE`, `DELETE` e `TRUNCATE`) e a API não expõe nenhuma rota de escrita sobre ela.

Limite conhecido: um superusuário do banco pode desabilitar gatilhos. A proteção definitiva exige papéis de banco separados (aplicação sem privilégio de DDL nem de `DISABLE TRIGGER`), a definir no ADR de implantação.

## Decisões de implementação da Fase 2

| Tema | Decisão |
|---|---|
| IDs | `uuid` gerado pelo banco (`gen_random_uuid()`), imutável por gatilho |
| Dinheiro | `bigint` em centavos; API aceita só inteiros dentro do inteiro seguro de JS |
| Concorrência | Controle otimista: `PATCH` exige `versaoEsperada`; divergência retorna 409 |
| Exclusão | Emenda não pode ser excluída fisicamente (gatilho); cancelamento lógico virá em fase futura |
| Usuário | Cabeçalho `X-Usuario` **provisório**, só para atribuir a auditoria. **Não é autenticação** |
| Tipos de emenda | `individual` e `bancada` — rótulos neutros; sem limites, percentuais ou prazos |
| Situação | Apenas `rascunho`; o fluxo de tramitação só será modelado com validação jurídica |
| Dados de teste | Schema isolado por execução de teste; seed fictício só em `AMBIENTE=desenvolvimento` |

## Consequências

- Mais SQL manual que com ORM, em troca de transparência e controle.
- Autenticação, papéis e implantação ficam como decisões seguintes (ver `docs/pendencias.md`).
