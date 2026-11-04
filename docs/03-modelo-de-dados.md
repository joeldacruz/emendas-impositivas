# 03 — Modelo de dados conceitual

Conceitual: nomes e tipos podem mudar na implementação. Convenções:

- Chaves primárias internas imutáveis (UUID ou equivalente).
- Valores monetários em **centavos inteiros** (`bigint`) ou `numeric` exato; nunca ponto flutuante.
- Tabelas com vigência usam `vigencia_inicio` / `vigencia_fim`.
- Exclusão lógica; histórico na trilha de auditoria.

## 1. Núcleo

```
exercicio(id, ano, ...)
parametro_legal(id, exercicio_id?, codigo, valor, vigencia_inicio, vigencia_fim,
                fonte_normativa_id, status_validacao, validado_por, validado_em)
fonte_normativa(id, tipo, identificacao, vigencia, url_ou_referencia)

parlamentar(id, nome, ...)
mandato(id, parlamentar_id, inicio, fim)
bancada(id, nome, exercicio_id)
bancada_membro(id, bancada_id, parlamentar_id, vigencia_inicio, vigencia_fim)

emenda(id [imutável], exercicio_id, numero_oficial?, tipo, objeto, area,
       valor_proposto_centavos, situacao, classificacao_publicidade)
emenda_identificador_externo(id, emenda_id, sistema, tipo_id, valor_id)   -- ex.: IPM
emenda_autoria(id, emenda_id, parlamentar_id?, bancada_id?, percentual?)  -- autoria múltipla
emenda_beneficiario(id, emenda_id, beneficiario_id, valor_centavos?)
beneficiario(id, nome, documento_hash?, tipo)
```

`numero_oficial` e `emenda_identificador_externo` ficam **separados** do `id` interno: o número oficial pode mudar, ser reatribuído ou não existir ainda.

## 2. Planejamento e acompanhamento

```
plano_trabalho(id, emenda_id, versao, situacao)
meta(id, plano_id, descricao, ...)
item_plano(id, meta_id, descricao, quantidade, valor_unitario_centavos, ...)
cronograma_marco(id, item_id, previsto_para, realizado_em?)

execucao_fisica(id, item_id, data, quantidade_entregue, observacao)
alteracao_emenda(id, emenda_id, tipo [impedimento|alteracao|remanejamento], justificativa,
                 valor_origem?, valor_destino?, emenda_destino_id?, situacao)

prestacao_contas(id, emenda_id, protocolo, situacao)
analise_prestacao(id, prestacao_id, parecer, resultado, analisado_por, data)
```

## 3. Tramitação e documentos

```
tramitacao(id, emenda_id, etapa, responsavel_id, prazo, concluida_em?)
analise_parecer(id, emenda_id, tipo [parecer|diligencia|analise], texto, autor_id, data)
documento(id, referencia_tipo, referencia_id, titulo, hash, classificacao_publicidade,
          origem [interna|ipm-empenho|ipm-liquidacao|documento-fiscal], ...)
```

`documento.origem` separa os locais onde anexos aparecem na IPM (empenho, liquidação, documento fiscal), pois a publicação não é uniforme. Ausência de anexo público não implica ausência de liquidação.

## 4. Espelho financeiro (IPM)

```
ipm_lote(id, conector, iniciado_em, finalizado_em, data_referencia, situacao, totais...)
ipm_erro(id, lote_id, registro_ref, tipo, mensagem, payload?)
ipm_registro_bruto(id, lote_id, entidade, chave_origem, hash_conteudo, payload, recebido_em)

registro_financeiro(id, tipo [empenho|subempenho|reforco|anulacao|complementacao|
                      liquidacao|estorno_liquidacao|pagamento|estorno_pagamento|
                      resto_a_pagar|mov_resto],
                    entidade, unidade_gestora, exercicio, numero_origem, chave_origem [única por origem],
                    registro_pai_id?, data_documento, valor_centavos, sinal,
                    dotacao, classificacao_orcamentaria, credor_id?,
                    origem, data_referencia, sincronizado_em, lote_id, hash_conteudo)
credor(id, nome, documento_hash?, ...)
anexo_referencia(id, registro_financeiro_id, origem_anexo, descricao, url_publica?, disponivel)

vinculo_emenda_registro(id, emenda_id, registro_financeiro_id, valor_alocado_centavos,
                        metodo [identificador|manual|regra], confirmado_por?, confirmado_em?)
pendencia_conferencia(id, tipo, referencia, descricao, situacao, resolvida_por?, resolvida_em?)
conciliacao(id, emenda_id, lote_id, total_interno, total_origem, diferenca, situacao)
```

### Regras do modelo

- **Preservação**: movimentos originais e estornos são registros próprios; nunca se edita ou apaga o original.
- **Idempotência**: `UNIQUE(origem, chave_origem)` + `hash_conteudo`. Reimportação igual não grava; conteúdo diferente gera nova versão e pendência de conferência.
- **Rateio**: `vinculo_emenda_registro.valor_alocado_centavos` permite um registro atender várias emendas; a soma dos vínculos de um registro não pode exceder o valor do registro.
- **Sem duplicação na consolidação**: totais de uma emenda somam **vínculos** (valor alocado), não registros brutos.
- **Estados distintos**: empenhado, liquidado e pago são derivados de tipos de registro financeiro; "objeto entregue" vem de `execucao_fisica`; "prestação aprovada" de `analise_prestacao`.
- **Divergência**: nunca corrige a origem; gera `pendencia_conferencia`.

## 5. Auditoria e publicação

```
auditoria(id, entidade, entidade_id, acao, antes, depois, usuario_id, em, origem)  -- append-only
publicacao_emenda(emenda_id, versao, dados_publicaveis, publicado_em)              -- projeção para o portal
```
