# Formato interno de importação financeira — versão 1

> **Este formato é nosso. Não é um layout oficial da IPM/Atende.Net** e não presume API, arquivo de exportação ou campo da rotina 45679. Serve ao núcleo simulado da Fase 6A (dados **fictícios**). Quando houver contrato de dados confirmado, um conector traduzirá a origem para este formato (ou para uma versão posterior).

Exemplos: [lote-ficticio-01.json](../../exemplos/importacao-financeira/lote-ficticio-01.json) (lote limpo) e [lote-ficticio-02-com-problemas.json](../../exemplos/importacao-financeira/lote-ficticio-02-com-problemas.json) (reimportação com rejeições, divergência e movimento sem vínculo).

## Arquivo (JSON)

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `formato` | texto | sim | fixo: `emendas-impositivas/importacao-financeira` |
| `versao` | inteiro | sim | fixo: `1` |
| `origem` | texto | sim | `SIMULADO-` + letras maiúsculas, dígitos ou `-` (ex.: `SIMULADO-FICTICIO`). Qualquer outra origem é recusada pelo programa **e** pelo banco |
| `exercicio` | inteiro | sim | ano; precisa estar cadastrado no sistema |
| `unidadeGestora` | texto | sim | parte do escopo da chave |
| `dataReferencia` | data `AAAA-MM-DD` | sim | até quando os dados valem; nenhum documento pode ser posterior a ela |
| `registros` | lista | sim | até 20 000 itens |

Cabeçalho inválido recusa o lote inteiro: nada é gravado (o comando termina com a lista de motivos).

## Registro

Campos desconhecidos são **rejeitados** (o formato é fechado).

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `tipo` | texto | sim | `empenho`, `liquidacao`, `pagamento`, `estorno_liquidacao`, `estorno_pagamento` |
| `chaveOrigem` | texto | sim | identificador do registro na origem; base da idempotência |
| `registroPaiChave` | texto | conforme o tipo | liquidação → empenho; pagamento → liquidação; estorno de liquidação → liquidação; estorno de pagamento → pagamento. Empenho não tem pai. O pai deve estar no mesmo lote ou em lote anterior, no mesmo escopo |
| `numero` | texto | não | numeração como aparece na origem |
| `exercicioDocumento` | inteiro | não | se informado, deve ser igual ao `exercicio` do lote (restos a pagar não são suportados) |
| `dataDocumento` | data | sim | não pode ser posterior à `dataReferencia` do lote (checado **antes** de qualquer classificação como já importado ou divergente) nem anterior à do registro pai |
| `valorCentavos` | inteiro | sim | **centavos**, positivo; o sentido (estorno) vem do `tipo` |
| `dotacao` | texto | não | |
| `credorNome` | texto | não | dado sensível; guardado, mas **não exposto** na consulta |
| `identificadorEmenda` | texto | não | único meio de vínculo automático (ver abaixo) |

## Como o lote é tratado

1. **Validação** de cada registro; os inválidos viram linha `rejeitado` com os motivos, sem impedir os demais.
2. **Consolidação** dos válidos numa só transação, com importações serializadas, na ordem descrita em "Ordem de processamento" abaixo.
3. **Chave com escopo:** `(origem, exercício do lote, unidadeGestora, chaveOrigem)`.
4. **Conteúdo comparável:** todos os campos do registro exceto a chave. `hash = SHA-256` do conteúdo normalizado em ordem fixa.
5. **Resultado por linha** (tabela `importacao_linha`, imutável):

| Resultado | Quando | Efeito |
|---|---|---|
| `aceito` | chave nova e registro válido | movimento criado; vínculo automático se o identificador resolve; senão `sem_vinculo` e pendência aberta |
| `ja_importado` | mesma chave e mesmo hash | nada muda (idempotência) |
| `divergente` | mesma chave, hash diferente | movimento anterior **preservado**; pendência `divergencia_origem` aberta (uma por conteúdo divergente) |
| `rejeitado` | validação falhou | nada consolidado; motivos gravados |

6. **Saldos da cadeia** (rejeitam a linha, depois de reavaliada): Σ liquidações (líquidas de estornos) ≤ empenho; Σ pagamentos (líquidos de estornos) ≤ liquidação líquida de estornos; Σ estornos ≤ valor do registro estornado; estorno de liquidação não pode deixar a liquidação abaixo do já pago.

## Ordem de processamento do lote

O formato **não traz sequência de lançamento** e o programa **não a inventa**. A ordem é decidida assim:

1. Ordem inicial: `dataDocumento` (campo informado pela origem) e, em caso de empate, a posição da linha no arquivo. A posição serve só de desempate determinístico; não é tratada como cronologia de lançamento.
2. Uma linha rejeitada **apenas por dependência** (registro pai ainda inexistente ou saldo insuficiente) não é rejeitada de imediato: é reavaliada depois das demais, em rodadas, até que uma rodada inteira não decida mais nada. Só então é rejeitada em definitivo, com o motivo.
3. Consequência: um estorno válido libera saldo para uma reposição no mesmo lote, em qualquer ordem do arquivo (ex.: empenho todo consumido → estorno de liquidação → liquidação substituta). Pai e filho com a mesma data funcionam mesmo com o filho listado primeiro.
4. Uma reposição **sem** estorno que a sustente continua rejeitada por falta de saldo: saldo nunca é inventado.
5. **Disputa pelo mesmo saldo** (duas linhas que não cabem juntas): vale a de menor (`dataDocumento`, posição) e a outra é rejeitada com o motivo. É uma regra de desempate, não uma afirmação sobre qual lançamento veio antes na origem; casos assim devem ser conferidos por uma pessoa (ver pendências).
6. Rejeições que não dependem de ordem (formato, data posterior à referência, exercício do documento, tipo do pai errado, data anterior à do pai, regra de integridade do banco) são imediatas.

## Vínculo com emenda

- **Automático:** somente quando `identificadorEmenda` coincide exatamente com um identificador externo cadastrado na emenda (`sistema` = origem do lote, `tipoId` = `emenda`), a emenda é do mesmo exercício e não está cancelada. Aloca o valor inteiro do movimento.
- **Manual** (`npm run financeiro -- vincular`): exige justificativa; permite rateio (valor parcial). Soma dos vínculos ativos ≤ valor do movimento (trava no banco).
- **Nunca** por credor, valor, data ou proximidade. Vínculo errado é **revogado** (com motivo), não apagado; o movimento volta a ficar pendente se não restar vínculo.
- **Estornos abatem por emenda.** Um estorno só pode ser alocado a uma emenda até a parcela do movimento **original** alocada **a essa mesma emenda**, descontados os estornos já alocados a ela (vale para estornos parciais acumulados e para rateio do original; garantido no banco, inclusive sob concorrência). Se faltar alocação compatível:
  - **importação:** o estorno é aceito como fato da origem, **não** é vinculado, e abre-se a pendência `estorno_sem_alocacao_compativel` **da emenda afetada** (a emenda do identificador), visível em `pendenciasAbertas` na consulta dela. A pendência só traz números da própria emenda, nunca a alocação de outra;
  - **vínculo manual:** é recusado com o motivo; vincular o estorno à emenda correta resolve a pendência.
- **Revogar o vínculo do original** que já tem estornos vinculados à mesma emenda é **bloqueado**; revogue antes os vínculos dos estornos.
- Os filhos não herdam o vínculo do pai: cada movimento é vinculado individualmente (decisão conservadora; ver pendências).

## Exemplo completo

Entrada (`lote-ficticio-01.json`, resumido; valores em centavos):

| # | tipo | chave | pai | valor | identificadorEmenda |
|---|---|---|---|---|---|
| 1 | empenho | EMP-0001 | — | 600000 | FIC-EMD-001 |
| 2 | liquidacao | LIQ-0001 | EMP-0001 | 400000 | FIC-EMD-001 |
| 3 | pagamento | PAG-0001 | LIQ-0001 | 250000 | FIC-EMD-001 |
| 4 | estorno_pagamento | ESTPAG-0001 | PAG-0001 | 50000 | FIC-EMD-001 |
| 5 | estorno_liquidacao | ESTLIQ-0001 | LIQ-0001 | 100000 | FIC-EMD-001 |
| 6 | empenho | EMP-0002 | — | 300000 | (nenhum) |

Resultado: 6 linhas aceitas, 1 sem vínculo (EMP-0002, pendência aberta). A consulta da emenda FICT-001 mostra empenhado 600000, liquidado 400000 (líquido 300000), pago 250000 (líquido 200000), estornos 100000 e 50000, data da última importação e a lista de movimentos com a decisão de vínculo de cada um.

## Consulta: carga × referência dos dados

`ultimaImportacao` é a **última carga** (quando foi feita e a referência do lote dessa carga). `referenciaMaisRecenteDosDados` é a **maior** referência entre os lotes que aceitaram ou reconheceram os movimentos da emenda; ela não retrocede quando se recarrega um lote histórico, que pode ter referência menor.
