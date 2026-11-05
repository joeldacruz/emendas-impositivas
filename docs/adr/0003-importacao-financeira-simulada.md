# ADR 0003 — Núcleo simulado de importação financeira (Fase 6A)

- **Situação:** aceita para a Fase 6A (aguardando revisão do PR).
- **Contexto:** a IPM será a fonte oficial da execução orçamentária e financeira, mas não há resposta sobre a rotina 45679, API, layout, autenticação ou permissão. O sistema ainda não tem autenticação.

## Decisões

1. **Núcleo desacoplado da origem.** Um formato interno versionado ([v1](../integracao-ipm/formato-importacao-v1.md)) separa o que o sistema consome do que a origem fornece. O conector real (6B) será um tradutor para esse formato.
2. **Só origem simulada.** O programa e o banco (CHECK em `importacao_lote.origem`) exigem o prefixo `SIMULADO-`. Abrir para dados reais exige migração própria e ADR.
3. **Importação por comando local**, não por rota. Sem autenticação não há carga exposta na rede; a API só consulta. Os comandos recusam `AMBIENTE=producao`.
4. **Idempotência por chave com escopo + hash do conteúdo.** Mesma chave e hash = ignorado; hash diferente = registro anterior preservado e pendência de conferência. O sistema **nunca** sobrescreve um movimento: a correção na origem aparece como pendência, decidida por pessoa. Aceitar o conteúdo novo exigirá versionamento do movimento (pendência registrada).
5. **Movimentos imutáveis; estorno é registro próprio** ligado ao original por referência. Valores em centavos inteiros positivos; o sentido vem do tipo.
6. **Vínculo só por identificador cadastrado ou decisão humana justificada.** Nada de dedução por credor, valor ou proximidade. Rateio por tabela de vínculos com soma ≤ valor do movimento, garantida por gatilho com trava da linha do movimento (segura sob concorrência). Vínculo errado é revogado, nunca apagado.
7. **Estados distintos.** Empenhado, liquidado e pago vêm dos movimentos; objeto entregue e prestação de contas aprovada não são derivados deles e aparecem como "não apurados".
8. **Auditoria** pelos mesmos gatilhos das demais tabelas (lote, movimento, pendência, vínculo); o vínculo carrega `emenda_id` e aparece na auditoria da emenda. O resultado de cada linha é gravado em tabela imutável.
9. **Importações serializadas** por trava de aconselhamento do PostgreSQL: duas cargas simultâneas não disputam as mesmas chaves.

## Adendo (revisão do PR 5) — migração 0007

10. **Estorno por emenda.** Um estorno só abate a parcela do movimento original alocada à mesma emenda (menos estornos irmãos já alocados a ela). Garantido por gatilho no banco, com trava do original (ordem fixa: emenda → movimento → original). Sem lastro na importação: o estorno é aceito como fato da origem, fica sem vínculo e abre-se pendência `estorno_sem_alocacao_compativel` da emenda afetada, sem revelar dados de outra emenda. Revogar o vínculo do original com estornos vinculados à mesma emenda é bloqueado (exige revogar os estornos antes).
11. **Ordem do lote sem cronologia inventada.** Ordem inicial por `dataDocumento` e posição (desempate); linhas rejeitadas só por dependência (pai ou saldo) são reavaliadas até não haver progresso. Disputa pelo mesmo saldo: menor (data, posição) vence, com a outra rejeitada e motivada.
12. **Data de referência primeiro.** A checagem de data/exercício do documento ocorre antes da detecção de duplicata e de divergência. A consulta separa a última carga da referência mais recente dos dados.

## Consequências

- Reimportar é seguro e barato; erro de formato de uma linha não derruba o lote.
- Limitações assumidas: sem restos a pagar, reforço/anulação/complementação; filhos não herdam vínculo do pai; divergência só pode ser "conferida", não "aceita". Todas listadas em `docs/pendencias.md`.
