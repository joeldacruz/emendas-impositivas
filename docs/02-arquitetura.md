# 02 — Arquitetura proposta

> Proposta para discussão. Stack e hospedagem **não foram decididas**; ver [ADR 0001](adr/0001-principios-tecnicos.md).

## Visão

Aplicação web com núcleo transacional, camada de integração isolada e um portal público alimentado apenas por dados explicitamente publicáveis.

```
             +-------------------+
 Servidores  |  Aplicação interna|----+
 (login)---> |  (gestão)         |    |
             +-------------------+    v
                      |        +-------------+      +-----------------+
                      |        | Banco       |<-----| Publicação      |
                      |        | (interno)   |      | (projeção       |
                      v        +-------------+      |  publicável)    |
             +-------------------+   ^              +--------+--------+
             | Módulo integração |---+                       |
             | IPM (somente      |   staging + lotes         v
             |  leitura)         |                  +-----------------+
             +---------+---------+                  | Portal público  |
                       |                            +-----------------+
                       v
              IPM / Atende.Net
              (fonte oficial)
```

## Módulos

| Módulo | Responsabilidade |
|---|---|
| Parâmetros | Exercícios, parâmetros legais versionados (vigência, fonte normativa, status de validação) |
| Parlamentares | Cadastro, mandatos, bancadas e composição histórica |
| Emendas | Cadastro, autoria múltipla, objeto, valores, beneficiários |
| Planos de trabalho | Metas, itens, cronogramas |
| Análise e tramitação | Pareceres, diligências, responsáveis, prazos, fluxo |
| Alterações | Impedimentos técnicos, alterações e remanejamentos |
| Execução física | Medições/entregas e evidências |
| Prestação de contas | Entrega, análise, resultado |
| Financeiro (espelho IPM) | Registros importados, vínculos, rateios, conciliação |
| Integração IPM | Conectores, staging, lotes, erros, idempotência |
| Documentos | Armazenamento com classificação (interno/público) |
| Auditoria | Trilha de alterações imutável |
| Portal e relatórios | Projeção publicável e relatórios |

## Integração IPM

Pipeline em etapas, com cada uma registrada em lote:

1. **Coleta**: conector específico por modalidade disponível (API, exportação de arquivo, consulta ao portal de transparência). A modalidade é **PENDENTE DE INVESTIGAÇÃO**.
2. **Staging bruto**: payload original preservado, com origem, data de referência e data de sincronização.
3. **Normalização**: mapeia para o modelo de registros financeiros, sem alterar o valor original.
4. **Carga idempotente**: chave natural da origem + hash do conteúdo; reimportar o mesmo dado não duplica.
5. **Vinculação**: associa registros a emendas (por identificador, quando existir; senão por regra explícita e conferência humana).
6. **Conciliação**: compara total interno x origem; divergência vira **pendência de conferência**. A origem nunca é corrigida silenciosamente.

Um conector é substituível: a modalidade real só afeta a etapa 1.

## Dados internos x publicáveis

- Todo dado e documento tem classificação de publicidade (`interno` | `publicavel`), definida por regra e revisão humana.
- O portal lê **somente** de uma projeção publicável, nunca das tabelas internas.
- Dados pessoais seguem a matriz de proteção de dados (LGPD) a validar juridicamente.

## Segurança e auditoria

- Autenticação e perfis por papel (a definir: parlamentar/assessoria, análise técnica, controle interno, administrador).
- Trilha de auditoria append-only de criação/alteração/exclusão lógica.
- Segredos de integração fora do repositório.
