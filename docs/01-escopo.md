# 01 — Escopo

## Objetivo

Gerir o ciclo de vida das emendas impositivas da Câmara de Vereadores de Três Barras/SC, da proposição à prestação de contas, trazendo da IPM/Atende.Net a execução orçamentária e financeira para acompanhamento e conciliação.

## Responsabilidades do sistema próprio

1. Exercícios e parâmetros legais versionados.
2. Parlamentares, bancadas e composição histórica.
3. Cadastro das emendas: autoria, objeto, valores e beneficiários.
4. Planos de trabalho: metas, itens e cronogramas.
5. Análises, pareceres, diligências e documentos.
6. Tramitação, responsáveis e prazos.
7. Impedimentos técnicos, alterações e remanejamentos documentados.
8. Acompanhamento da execução física.
9. Prestação de contas e análise dos resultados.
10. Auditoria e histórico de alterações.
11. Portal público e relatórios.

## Integração IPM (somente leitura)

Consulta/importação de: exercício, entidade e unidade gestora; identificadores da emenda e dos registros contábeis (quando disponíveis); dotação e classificação orçamentária; empenhos, subempenhos, reforços, anulações e complementações; liquidações e estornos; pagamentos e estornos; restos a pagar e movimentações posteriores; credores e destinatários; referências a documentos e anexos públicos; data de referência, origem e data da sincronização.

## Fora de escopo (nesta fase)

- Implementação do sistema.
- Escrita em qualquer sistema da IPM.
- Implementação de percentuais, rateios, prazos ou bloqueios jurídicos definitivos.
- Download ou versionamento de arquivos reais da IPM.
- Emissão de documentos contábeis oficiais (empenho, liquidação, pagamento).

## Estados que NÃO são equivalentes

| Estado | Fonte principal | Significado |
|---|---|---|
| Empenhado | IPM | Reserva orçamentária |
| Liquidado | IPM | Reconhecimento da despesa/direito do credor |
| Pago | IPM | Saída financeira efetivada |
| Objeto entregue | Sistema próprio | Execução física comprovada |
| Prestação de contas aprovada | Sistema próprio | Análise concluída e aceita |

Nenhum estado implica o seguinte. Um empenho pago pode ter objeto não entregue; um objeto entregue pode ter prestação reprovada. A modelagem e os relatórios devem manter os cinco estados separados.

## Glossário

- **Emenda**: proposição de destinação de recursos pelo parlamentar ou bancada.
- **Bancada**: grupo de parlamentares com autoria conjunta, com composição que varia no tempo.
- **Plano de trabalho**: detalhamento de metas, itens e cronograma de uma emenda.
- **Registro financeiro**: movimento originado na IPM (empenho, liquidação, pagamento, estorno etc.).
- **Rateio**: distribuição de um registro financeiro entre mais de uma emenda.
