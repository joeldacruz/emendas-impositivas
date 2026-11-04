# Emendas Impositivas

Sistema de gestão de emendas impositivas municipais, inicialmente para a Câmara de Vereadores de Três Barras/SC.

**Fase atual: fundação documental e técnica.** Nenhum código de produto foi implementado.

## Diretriz

- Toda a gestão das emendas é feita **neste sistema**.
- A integração com **IPM/Atende.Net** se limita à **consulta/importação** da execução orçamentária e financeira.
- A IPM permanece como **fonte oficial dos registros contábeis**. Este sistema nunca escreve no banco da IPM.
- Nada aqui presume API, autenticação, layout ou acesso da IPM. Tudo isso está registrado como hipótese a validar.
- Parâmetros jurídicos (percentuais, prazos, bloqueios) estão **PENDENTES DE VALIDAÇÃO** e não são regras do sistema.

## Documentos

| Documento | Conteúdo |
|---|---|
| [docs/01-escopo.md](docs/01-escopo.md) | Escopo, fora de escopo, glossário e estados que não são equivalentes |
| [docs/02-arquitetura.md](docs/02-arquitetura.md) | Arquitetura proposta, módulos, fronteira interno/público |
| [docs/03-modelo-de-dados.md](docs/03-modelo-de-dados.md) | Modelo de dados conceitual |
| [docs/04-requisitos.md](docs/04-requisitos.md) | Requisitos funcionais e não funcionais |
| [docs/05-plano-de-implementacao.md](docs/05-plano-de-implementacao.md) | Fases, entregas e critérios de aceite |
| [docs/integracao-ipm/investigacao-ipm.md](docs/integracao-ipm/investigacao-ipm.md) | Evidências, hipóteses e roteiro de investigação da IPM |
| [docs/juridico/matriz-requisitos-juridicos.md](docs/juridico/matriz-requisitos-juridicos.md) | Matriz de validação com Jurídico, Contabilidade e Controle Interno |
| [docs/adr/0001-principios-tecnicos.md](docs/adr/0001-principios-tecnicos.md) | Decisões técnicas fundamentais |
| [docs/pendencias.md](docs/pendencias.md) | Lacunas conhecidas e perguntas em aberto |

## Convenções

- Itens marcados **PENDENTE DE VALIDAÇÃO** não podem virar regra de código sem conferência documentada.
- Não versionar arquivos reais da IPM (notas de empenho, DANFE, etc.) nem dados pessoais reais neste repositório.
