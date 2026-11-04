# Investigação da integração IPM/Atende.Net

## Princípios

- A IPM é a fonte oficial dos registros contábeis.
- Integração **somente leitura**; nunca escrever no banco da IPM.
- Nada abaixo presume API, autenticação, layout ou acesso.

## Evidências recuperadas

Relatório de rotinas do Atende.Net da Câmara, emitido em **27/07/2026**:

| Rotina | Nome |
|---|---|
| 45664 | e-Sfinge Emendas — Parlamentar |
| 45665 | e-Sfinge Emendas — Agrupamento Legislativo |
| 45666 | e-Sfinge Emendas — Emenda |
| 45667 | e-Sfinge Emendas — Plano de Trabalho |
| 45679 | Execução Orçamentária e Financeira de Emendas Parlamentares |

**O que isso comprova:** existência no catálogo.
**O que isso não comprova:** contratação, permissão de acesso, API ou cobertura funcional integral.

**Investigação prioritária:** a rotina 45679 fornece vínculos e movimentos suficientes para alimentar este sistema?

## Observação histórica do portal (15/10/2026)

Referência documental, não comprovação de API nem do estado atual. Arquivos reais **não** são baixados nem versionados.

- Portal: <https://camaratresbarras.atende.net/transparencia/item/liquidacao-de-empenhos#conteudo>
- Empenho 603/2026, emitido em 30/09/2026; credor MH Comércio Ltda.; objeto: cinco unidades de água mineral de 20 litros; valor R$ 134,50.
- Liquidação 845/2026, de 09/10/2026; NF-e 003016, de 30/09/2026.
- Nota de empenho e DANFE abertos na aba "Anexos do Empenho"; aba "Anexos da Liquidação" vazia.
- Valores do empenho, da liquidação e do DANFE coincidiam.
- Consulta equivalente da Prefeitura: liquidação existente sem documentos na aba Documentos.

**Consequências para o modelo:**
- Ausência de anexo público não significa ausência de liquidação.
- Anexos podem estar no empenho, na liquidação ou no documento fiscal: modelados separadamente (`anexo_referencia.origem_anexo`).
- Não presumir publicação uniforme entre entidades.

## Perguntas a responder

| # | Pergunta | Quem responde | Situação |
|---|---|---|---|
| 1 | A Câmara contratou/tem permissão para a rotina 45679? | Câmara / IPM | Aberta |
| 2 | Quais modalidades de acesso existem (API, exportação, relatório, banco de leitura, portal)? | IPM | Aberta |
| 3 | Há documentação técnica, layout e versionamento? | IPM | Aberta |
| 4 | Como é feita a autenticação e quem autoriza? | IPM / TI | Aberta |
| 5 | A rotina identifica a emenda em cada empenho? Com qual identificador? | IPM / Contabilidade | Aberta |
| 6 | Como são representados reforços, anulações, complementações, subempenhos? | IPM | Aberta |
| 7 | Como são representados estornos de liquidação e pagamento? | IPM | Aberta |
| 8 | Restos a pagar e movimentações posteriores estão incluídos? | IPM | Aberta |
| 9 | Credores e destinatários de pagamento estão disponíveis? | IPM | Aberta |
| 10 | Há referências a anexos e como são acessadas? | IPM | Aberta |
| 11 | Há limites de volume, frequência ou janela de consulta? | IPM | Aberta |
| 12 | Os dados de e-Sfinge Emendas (45664–45667) podem ser lidos para conferência cruzada? | IPM / Contabilidade | Aberta |
| 13 | Como é um rateio entre emendas na origem? | Contabilidade | Aberta |

## Roteiro

1. Confirmar contratação e permissões (Câmara).
2. Solicitar à IPM documentação, layout e modalidade de acesso da 45679.
3. Obter amostra **anonimizada ou autorizada** de dados reais; guardar fora do repositório.
4. Mapear campos da 45679 para `registro_financeiro` e `vinculo_emenda_registro`.
5. Classificar a lacuna: campos ausentes, vínculo ausente, só portal público.
6. Decidir modalidade do conector e registrar em ADR.
7. Escrever relatório de viabilidade.

## Cenários

- **A. Acesso estruturado com vínculo emenda↔movimento:** importação direta, conciliação automática.
- **B. Acesso sem vínculo à emenda:** importação e vinculação manual/regra com conferência humana.
- **C. Só portal de transparência:** coleta de dados públicos, cobertura reduzida, alto custo de manutenção; registrar riscos antes de adotar.
- **D. Sem acesso:** registro manual de referências, sem integração, com conferência periódica.

## Mapeamento preliminar (hipótese)

| Item IPM (esperado) | Destino no modelo |
|---|---|
| Exercício, entidade, unidade gestora | `registro_financeiro.exercicio/entidade/unidade_gestora` |
| Dotação e classificação | `registro_financeiro.dotacao/classificacao_orcamentaria` |
| Empenho, subempenho, reforço, anulação, complementação | `registro_financeiro.tipo` |
| Liquidação e estorno | idem |
| Pagamento e estorno | idem |
| Restos a pagar e movimentos | idem |
| Credor | `credor` |
| Anexos | `anexo_referencia` |
| Identificador da emenda | `emenda_identificador_externo` |
| Data de referência / sincronização | `registro_financeiro.data_referencia/sincronizado_em` |
