# 04 — Requisitos

Prioridade: **M** = must, **S** = should, **C** = could. Itens ligados a regra jurídica dependem da [matriz jurídica](juridico/matriz-requisitos-juridicos.md).

## Funcionais

| ID | Requisito | Prio |
|---|---|---|
| RF-01 | Cadastrar exercícios e parâmetros legais versionados, com fonte normativa, vigência e status de validação | M |
| RF-02 | Cadastrar parlamentares, mandatos, bancadas e composição histórica por vigência | M |
| RF-03 | Cadastrar emendas com ID interno imutável, número oficial e identificadores externos separados | M |
| RF-04 | Suportar autoria múltipla (parlamentares e/ou bancadas) | M |
| RF-05 | Cadastrar objeto, valores e beneficiários da emenda | M |
| RF-06 | Cadastrar plano de trabalho com metas, itens e cronogramas, versionado | M |
| RF-07 | Registrar análises, pareceres, diligências e documentos | M |
| RF-08 | Controlar tramitação, responsáveis e prazos | M |
| RF-09 | Registrar impedimentos técnicos, alterações e remanejamentos com justificativa documentada | M |
| RF-10 | Registrar execução física | M |
| RF-11 | Registrar prestação de contas e sua análise | M |
| RF-12 | Manter trilha de auditoria de todas as alterações | M |
| RF-13 | Importar da IPM a execução orçamentária e financeira (somente leitura) | M |
| RF-14 | Importação repetida idempotente | M |
| RF-15 | Preservar movimentos originais, estornos e rastreabilidade até o registro de origem | M |
| RF-16 | Registrar lotes, erros, rejeições, conciliação e data de atualização | M |
| RF-17 | Divergências geram pendência de conferência; a origem nunca é corrigida silenciosamente | M |
| RF-18 | Vincular um registro financeiro a várias emendas (rateio) sem duplicar valores na consolidação | M |
| RF-19 | Uma emenda pode ter vários empenhos e pagamentos | M |
| RF-20 | Exibir separadamente: empenhado, liquidado, pago, objeto entregue, prestação aprovada | M |
| RF-21 | Modelar separadamente anexos do empenho, da liquidação e do documento fiscal; ausência de anexo ≠ ausência de liquidação | M |
| RF-22 | Classificar dados e documentos como internos ou publicáveis | M |
| RF-23 | Portal público alimentado só por projeção publicável | S |
| RF-24 | Relatórios gerenciais e de controle (por emenda, parlamentar, exercício, situação) | S |
| RF-25 | Alertas de prazo e de divergência | C |

## Não funcionais

| ID | Requisito | Prio |
|---|---|---|
| RNF-01 | Valores monetários em decimal exato ou centavos inteiros; nunca float | M |
| RNF-02 | Nenhuma escrita em sistema/banco da IPM | M |
| RNF-03 | Auditoria append-only; alteração de registro auditado não apaga histórico | M |
| RNF-04 | Conformidade com LGPD; minimização de dados pessoais publicados (a validar) | M |
| RNF-05 | Perfis de acesso por papel; princípio do menor privilégio | M |
| RNF-06 | Segredos fora do repositório | M |
| RNF-07 | Conectores IPM substituíveis sem impacto no restante do sistema | S |
| RNF-08 | Backups e restauração testados | S |
| RNF-09 | Acessibilidade do portal público (a validar o padrão exigido) | S |
| RNF-10 | Testes automatizados para idempotência, estornos, rateio e consolidação | M |

## Premissas a validar

- Que a rotina 45679 da IPM forneça vínculos e movimentos suficientes.
- Que o município possa acessar essa rotina por alguma modalidade técnica.
- Que a Câmara tenha contratação/permissão para tal acesso.
