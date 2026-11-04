# 05 — Plano de implementação

Cada fase termina com entrega revisável. A ordem prioriza reduzir incerteza sobre a IPM e o jurídico antes de codificar regras.

## Fase 0 — Fundação (esta)
Documentos de escopo, arquitetura, modelo, requisitos, plano, matriz jurídica e roteiro de investigação da IPM.
**Aceite:** documentos revisados pelo responsável.

## Fase 1 — Investigação (em paralelo à Fase 2)
- Investigar a rotina 45679 e a modalidade de acesso (ver [investigação IPM](integracao-ipm/investigacao-ipm.md)).
- Levantar a legislação vigente (ver [matriz jurídica](juridico/matriz-requisitos-juridicos.md)).
**Aceite:** relatório de viabilidade da integração; matriz jurídica com status por item.

## Fase 2 — Esqueleto técnico
Decidir a stack (ADR), repositório estruturado, CI, migrações, autenticação e papéis, auditoria base.
**Aceite:** aplicação sobe, autentica, grava e audita uma entidade de exemplo.

## Fase 3 — Cadastros (entregue em PR; aguardando revisão)
Exercícios, parâmetros versionados (todos marcados como não validados), parlamentares, bancadas, composição histórica.
**Aceite:** consulta de composição de bancada em uma data.

## Fase 4 — Emendas (entregue em PR; aguardando revisão)
Emenda com ID interno, número oficial, identificadores externos, autoria múltipla, objeto, valores, beneficiários. Sem bloqueios jurídicos até a validação.
**Aceite:** ciclo completo de cadastro e edição com auditoria.

## Fase 5 — Planos, tramitação e documentos (entregue em PR; aguardando revisão)
Plano de trabalho, metas, itens, cronogramas; pareceres, diligências, prazos; classificação de publicidade.

## Fase 6 — Integração IPM (conforme viabilidade)
Staging, lotes, carga idempotente, vinculação, rateio, conciliação, pendências. Conector conforme a modalidade encontrada na Fase 1.
**Aceite:** reimportação não duplica; estornos preservados; divergência gera pendência.

## Fase 7 — Execução física e prestação de contas
Entrega do objeto, prestação, análise e resultado, com os cinco estados distintos no painel.

## Fase 8 — Portal público e relatórios
Projeção publicável, portal, relatórios, revisão de LGPD.

## Fase 9 — Homologação e produção
Validação com Jurídico, Contabilidade e Controle Interno; parâmetros legais promovidos a validados; plano de implantação.

## Riscos

| Risco | Mitigação |
|---|---|
| IPM sem API/acesso para a rotina 45679 | Conector substituível; alternativas (exportação, portal) avaliadas na Fase 1 |
| Cobertura funcional da rotina insuficiente | Vinculação manual com conferência; documentar lacunas |
| Legislação mudar ou estar desatualizada | Parâmetros versionados e com status de validação |
| Publicação de dado pessoal indevido | Classificação interno/publicável com revisão humana |
| Divergências frequentes com a IPM | Pendência de conferência e relatório de conciliação |
