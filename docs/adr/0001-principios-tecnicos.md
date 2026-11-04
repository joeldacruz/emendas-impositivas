# ADR 0001 — Princípios técnicos

Status: **Proposto** · Data: 2026-11-04

## Contexto

O sistema gerencia emendas e espelha dados contábeis da IPM, com exigência de rastreabilidade e transparência.

## Decisões

1. **ID interno imutável** (UUID) para toda emenda; número oficial e IDs externos em campos separados.
2. **Dinheiro em centavos inteiros** (`bigint`) ou `numeric` exato; sem ponto flutuante.
3. **IPM somente leitura**; nenhuma escrita no banco da IPM.
4. **Registros financeiros imutáveis**: estornos e correções são novos registros; o original é preservado.
5. **Importação idempotente** por chave de origem + hash de conteúdo.
6. **Staging bruto** antes da normalização, com lote, origem, data de referência e data de sincronização.
7. **Divergência gera pendência**, nunca correção silenciosa da origem.
8. **Consolidação por vínculos** (valor alocado), não por registros brutos, para evitar duplicação.
9. **Parâmetros legais versionados** com status de validação; não validados não bloqueiam.
10. **Separação interno/publicável**: o portal lê só de uma projeção publicável.
11. **Auditoria append-only**.
12. **Conector IPM substituível**.

## Pendente de decisão (ADRs futuros)

- Linguagem/framework, banco de dados (inclinação: PostgreSQL pela integridade relacional e tipos exatos), hospedagem.
- Modalidade do conector IPM (depende da investigação).
- Mecanismo de autenticação/autorização.
- Armazenamento de documentos.

## Consequências

Mais tabelas e processos de conferência, em troca de rastreabilidade e segurança jurídica.
