# Investigação IPM — minuta de solicitação técnica e contrato de dados proposto

> **Rascunho. Nada foi enviado.** Este documento só redige a solicitação e o contrato de dados proposto. Não presume API, autenticação, endpoints, credenciais nem layout oficial da IPM. O roteiro, as evidências e os cenários continuam em [integracao-ipm/investigacao-ipm.md](integracao-ipm/investigacao-ipm.md).

## 1. Quem responde o quê

| Legenda | Significado |
|---|---|
| **IPM** | Só a IPM/Atende.Net pode responder (produto, API, layout, regras do sistema) |
| **Câmara/Prefeitura** | Só a Câmara, a Prefeitura ou o município pode responder (contrato, permissões, práticas contábeis locais) |
| **Ambas** | Depende de confirmação cruzada |

| # | Pergunta | Quem responde |
|---|---|---|
| 1 | A Câmara contratou/tem permissão para a rotina 45679 (Execução Orçamentária e Financeira de Emendas Parlamentares)? | **Câmara/Prefeitura** (contrato e permissões), confirmado pela **IPM** |
| 2 | Quais modalidades de acesso existem (API, exportação de arquivo, relatório, leitura de banco, portal de transparência)? | **IPM** |
| 3 | Existe documentação técnica, layout e versionamento dos dados? | **IPM** |
| 4 | Como é feita a autenticação e quem autoriza o acesso? | **IPM** (mecanismo); **Câmara/Prefeitura** (quem autoriza) |
| 5 | A rotina identifica a emenda em cada empenho? Com qual identificador? | **IPM** (o que o sistema permite); **Câmara/Prefeitura** (se a prática de cadastro preenche) |
| 6 | Como são representados reforços, anulações, complementações e subempenhos? | **IPM** |
| 7 | Como são representados estornos de liquidação e de pagamento? | **IPM** |
| 8 | Restos a pagar e movimentações posteriores estão incluídos? | **IPM** |
| 9 | Credores e destinatários de pagamento estão disponíveis? | **IPM** (disponibilidade técnica); **Câmara/Prefeitura** (restrições de divulgação) |
| 10 | Há referências a anexos e como são acessadas? | **IPM** |
| 11 | Há limites de volume, frequência ou janela de consulta? | **IPM** |
| 12 | Os dados do e-Sfinge Emendas (rotinas 45664 a 45667) podem ser lidos para conferência cruzada? | **Ambas** |
| 13 | Como um rateio entre emendas é representado na origem? | **Ambas**: **IPM** (representação no sistema) e **Câmara/Prefeitura** (prática contábil adotada) |

## 2. Minuta de solicitação técnica

**Para:** IPM Sistemas — suporte/atendimento técnico do Atende.Net
**De:** [responsável pelo projeto — a preencher]
**Entidade:** Câmara de Vereadores de Três Barras/SC
**Assunto:** Solicitação de informações técnicas sobre a rotina 45679 — Execução Orçamentária e Financeira de Emendas Parlamentares

Prezados,

A Câmara de Vereadores de Três Barras/SC está desenvolvendo um sistema próprio para gestão das emendas impositivas. A IPM/Atende.Net continuará sendo a fonte oficial dos registros contábeis; nosso sistema fará apenas **consulta e importação, somente leitura**, da execução orçamentária e financeira. Não haverá escrita nos dados da IPM.

Em relatório de rotinas do Atende.Net emitido em 27/07/2026, constam as rotinas 45664 a 45667 (e-Sfinge Emendas) e 45679 (Execução Orçamentária e Financeira de Emendas Parlamentares). Esse relatório mostra que as rotinas existem no catálogo; ele não indica se estão contratadas, se temos permissão de acesso nem o que cobrem.

Solicitamos, por escrito, resposta às perguntas abaixo (as de contrato e permissão serão confirmadas internamente pela Câmara):

1. A rotina 45679 está disponível para a Câmara? Como confirmar a contratação e as permissões?
2. Quais modalidades de acesso existem para os dados dessa rotina (API, exportação de arquivo, relatório, outra)?
3. Há documentação técnica, layout dos dados e política de versionamento? Pedimos o material.
4. Qual o mecanismo de autenticação e o procedimento de autorização?
5. A rotina identifica a emenda em cada empenho? Qual identificador?
6. Como são representados empenhos, subempenhos, reforços, anulações e complementações?
7. Como são representados estornos de liquidação e de pagamento?
8. Restos a pagar e suas movimentações posteriores estão incluídos?
9. Credores e destinatários dos pagamentos estão disponíveis?
10. Há referências a documentos e anexos? Como são acessadas (empenho, liquidação, documento fiscal)?
11. Existem limites de volume, frequência ou janela de consulta?
12. Os dados das rotinas 45664 a 45667 (e-Sfinge Emendas) podem ser lidos para conferência cruzada?
13. Como um mesmo registro financeiro que atenda mais de uma emenda (rateio) é representado?

Em caso de necessidade de amostra de dados, pedimos que seja anonimizada ou formalmente autorizada pela Câmara.

Atenciosamente,
[nome, cargo, contato — a preencher]

### Mensagem interna à Câmara/Prefeitura (minuta)

Para prosseguir com a integração, precisamos que a Câmara/Prefeitura confirme: (1) se a rotina 45679 está contratada e com permissões habilitadas; (4) quem autoriza o acesso a dados da IPM e por qual procedimento; (5, 13) como o cadastro contábil identifica a emenda em cada empenho e como se registra um rateio entre emendas; (9) se há restrição à divulgação de credores e destinatários; (12) se a leitura das rotinas e-Sfinge de emendas é permitida para conferência. Estas respostas dependem de Contabilidade e Controle Interno.

## 3. Contrato de dados proposto (interno, não oficial)

Este é o formato que **nosso sistema espera** em um conector. Ele não descreve nenhum layout da IPM. O conector concreto (a definir após as respostas acima) é que traduz a origem para este contrato.

Princípios: valores em centavos inteiros; cada registro preserva a chave da origem; movimentos originais e estornos são registros separados; nada é corrigido na origem.

### 3.1 Lote de importação

| Campo | Tipo | Observação |
|---|---|---|
| `loteId` | uuid | gerado por nós |
| `origem` | texto | nome do conector (ex.: identificação da modalidade de acesso) |
| `entidade` | texto | entidade/unidade gestora, conforme a origem |
| `exercicio` | inteiro | |
| `dataReferencia` | data | até quando os dados da origem valem |
| `sincronizadoEm` | timestamp | momento da coleta |
| `registros` | lista | ver abaixo |

### 3.2 Registro financeiro

| Campo | Tipo | Obrigatório | Observação |
|---|---|---|---|
| `tipo` | enum | sim | `empenho`, `subempenho`, `reforco`, `anulacao`, `complementacao`, `liquidacao`, `estorno_liquidacao`, `pagamento`, `estorno_pagamento`, `resto_a_pagar`, `movimento_resto` — a correspondência com a representação real da origem **depende das respostas 6, 7 e 8** |
| `chaveOrigem` | texto | sim | identificador estável do registro na origem; base da idempotência |
| `registroPaiChave` | texto | não | liga liquidação a empenho, pagamento a liquidação etc., quando a origem informar |
| `numero`, `exercicioDocumento` | texto, inteiro | não | numeração como aparece na origem |
| `dataDocumento` | data | sim | |
| `valorCentavos` | inteiro | sim | sempre positivo; o sentido vem do `tipo` |
| `dotacao`, `classificacaoOrcamentaria` | texto | não | |
| `credorNome`, `credorDocumento` | texto | não | sujeitos à resposta 9 e à LGPD; documento deve ser tratado como dado pessoal |
| `identificadorEmenda` | texto | não | depende da resposta 5; sem ele, a vinculação é manual |
| `hashConteudo` | texto | sim | calculado por nós sobre o conteúdo normalizado |
| `payloadOriginal` | json | sim | preservado no staging |

### 3.3 Referência de anexo

| Campo | Tipo | Observação |
|---|---|---|
| `registroChave` | texto | registro ao qual o anexo se refere |
| `origemAnexo` | enum | `empenho`, `liquidacao`, `documento_fiscal` — modelados separadamente |
| `descricao` | texto | |
| `urlPublica` | texto | só se a origem fornecer; nunca presumida |
| `disponivel` | booleano | `false` não significa que o ato inexiste |

Os arquivos reais não são baixados nem versionados nesta fase.

### 3.4 Regras de importação (esperadas)

1. **Idempotência:** chave `(origem, chaveOrigem)` + `hashConteudo`. Mesmo hash: ignora. Hash diferente: nova versão do registro e pendência de conferência.
2. **Estornos:** registros próprios, ligados ao original; o original não é alterado.
3. **Divergência:** gera pendência de conferência; a origem nunca é corrigida.
4. **Vinculação a emendas:** pelo identificador, quando existir; senão manual, com confirmação humana.
5. **Rateio:** um registro pode ter várias alocações; a soma das alocações não excede o valor do registro.
6. **Estados distintos:** empenhado, liquidado e pago vêm da origem; objeto entregue e prestação aprovada vêm do sistema próprio.

### 3.5 Pendências do contrato

- Todo o mapeamento `tipo` ↔ representação real na origem (respostas 6 a 8).
- Existência e formato de `identificadorEmenda` (resposta 5).
- Representação de rateio (resposta 13).
- Disponibilidade e tratamento de dados de credores (resposta 9).
- Modalidade, autenticação e limites do conector (respostas 2, 4 e 11).
