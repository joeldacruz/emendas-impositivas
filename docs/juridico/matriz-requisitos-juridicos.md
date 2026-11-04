# Matriz de requisitos jurídicos — a validar

**Todos os itens abaixo estão PENDENTES DE VALIDAÇÃO** com Jurídico, Contabilidade e Controle Interno. Nenhum percentual, rateio, prazo ou bloqueio pode virar regra de código com base apenas neste documento. Regras federais não são transportadas automaticamente para o município.

Status possíveis: `PENDENTE` · `EM CONFERÊNCIA` · `VALIDADO` · `NÃO APLICÁVEL`.

## Fontes normativas a levantar

| # | Fonte | Observação | Responsável | Status |
|---|---|---|---|---|
| F1 | Lei Orgânica consolidada vigente | O arquivo antes chamado "LEI ORGÂNICA.pdf" continha a **Emenda à Lei Orgânica nº 0023/2023**, não a consolidação atual. **Não tratar como consolidação.** | Jurídico | PENDENTE |
| F2 | LDO de cada exercício | Disposições sobre emendas | Contabilidade | PENDENTE |
| F3 | LOA de cada exercício | Dotações e programações | Contabilidade | PENDENTE |
| F4 | Normas municipais específicas | Leis/decretos/resoluções sobre emendas | Jurídico | PENDENTE |
| F5 | Normas e layouts atuais do TCE/SC e e-Sfinge | Obrigações e leiautes vigentes | Controle Interno | PENDENTE |
| F6 | Decisões do STF aplicáveis, incluindo ADPF 854 | Transparência e rastreabilidade; alcance para o município a verificar | Jurídico | PENDENTE |
| F7 | Transparência (Lei de Acesso à Informação e correlatas) | Dados publicáveis | Jurídico | PENDENTE |
| F8 | Proteção de dados pessoais (LGPD) | Publicação de beneficiários, credores etc. | Jurídico / DPO | PENDENTE |

## Parâmetros a conferir

Mencionados no texto consultado (EC à LO 0023/2023), **sem valor de regra**:

| # | Parâmetro | Texto mencionado (não validado) | Fonte a conferir | Status |
|---|---|---|---|---|
| P1 | Limite de emendas individuais | 2% (base temporal específica) | F1, F2 | PENDENTE |
| P2 | Parcela destinada à saúde | metade do limite individual | F1, F2 | PENDENTE |
| P3 | Limite de emendas de bancada | até 1% (base temporal específica) | F1, F2 | PENDENTE |
| P4 | Base de cálculo e exercício de referência | a definir | F1–F3 | PENDENTE |
| P5 | Prazos de proposição, análise, execução e prestação | a levantar | F1–F5 | PENDENTE |
| P6 | Impedimentos técnicos e remanejamentos: hipóteses e trâmite | a levantar | F1–F4 | PENDENTE |
| P7 | Regras de rateio entre parlamentares/bancadas | a levantar | F1–F4 | PENDENTE |
| P8 | Critérios de prestação de contas | a levantar | F1–F5 | PENDENTE |

No sistema, esses parâmetros ficam em `parametro_legal` com `status_validacao`. Enquanto não `VALIDADO`, **não bloqueiam** operação; no máximo geram alerta informativo.

## Requisitos de sistema por tema

| Tema | Requisito de sistema | Depende de |
|---|---|---|
| Limites | Cálculo e verificação de limites | P1–P4 |
| Prazos | Controle de prazos legais | P5 |
| Impedimentos | Fluxo de impedimento/remanejamento | P6 |
| Rateio | Regras de repartição entre autores | P7 |
| Transparência | O que publicar, quando e em que formato | F5–F8 |
| LGPD | Base legal, minimização, retenção, direitos do titular | F8 |
| e-Sfinge | Eventual geração/conferência de dados nos leiautes | F5 |
| Prestação de contas | Documentos e critérios exigidos | P8 |

## Registro de validação

| Item | Validado por | Cargo/Setor | Data | Documento comprobatório |
|---|---|---|---|---|
| (vazio) | | | | |
