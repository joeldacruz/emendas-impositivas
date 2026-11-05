# Pendências e lacunas conhecidas

## Herdadas da Fase 0

1. **Briefing truncado:** o texto de requisitos técnicos recebido terminava em "Regras versionadas por exercício e…". O responsável orientou prosseguir; **confirmar o restante da frase**.
2. Contratação, permissão e modalidade de acesso à rotina 45679 da IPM: não confirmados. Minuta de solicitação em [investigacao-ipm.md](investigacao-ipm.md), **não enviada**.
3. Legislação vigente (Lei Orgânica consolidada, LDO, LOA, normas municipais, TCE/SC): não levantada.
4. Papéis e perfis de acesso: a definir com a Câmara.
5. Política de retenção e LGPD para beneficiários e credores: a definir.
6. Licença do repositório: não definida (repositório público; o `package.json` está como `UNLICENSED`).

## Abertas na Fase 2

7. **Autenticação e autorização:** não existem. O cabeçalho `X-Usuario` é provisório e **não protege nada**; a API não deve ser exposta fora de ambiente controlado.
8. **Papéis de banco:** a aplicação deve rodar sem privilégio de DDL nem de `DISABLE TRIGGER`; hoje só os gatilhos barram edição de auditoria.
9. ~~Cancelamento lógico~~ — entregue na Fase 4 (situações neutras `rascunho`, `cadastrada`, `cancelada`; o fluxo jurídico real de tramitação segue pendente, ver item 21).
10. ~~Vigência e bancadas~~ — entregue na Fase 3 (ver abaixo).
11. **Hospedagem, backup e implantação:** não decididos; sem deploy nesta fase.
12. **Docker em máquina de desenvolvimento:** o `docker-compose.yml` não pôde ser executado no ambiente desta fase (Docker Desktop não iniciou). A validação local usou PostgreSQL embutido; o CI usa PostgreSQL 16 em contêiner. Conferir o compose em máquina com Docker.
13. **Porta 3000:** reservada/ocupada em algumas máquinas Windows; a porta padrão da API é 3100.
14. ~~Anexos e documentos~~ — metadados e classificação entregues na Fase 5; o **armazenamento do arquivo** continua pendente (item 31).

## Abertas na Fase 3

15. **Quem pode validar parâmetros legais:** hoje qualquer chamada com `X-Usuario` muda o status. Falta perfil (ex.: Controle Interno/Jurídico) e fluxo de aprovação, dependentes de autenticação.
16. **Vínculo de bancada x mandato:** o sistema não exige que o parlamentar tenha mandato vigente para integrar uma bancada. Regra a definir com o Jurídico.
17. **Tipo da emenda x autoria:** emenda `bancada` não exige autor-bancada, nem o contrário. Depende da legislação.
18. **Bancada por exercício:** a bancada pertence a um exercício; se a bancada for permanente entre exercícios, o modelo muda.
19. **Catálogo de códigos de parâmetros:** `codigo` é texto livre; um catálogo (P1 a P8 da matriz jurídica) só deve ser fixado após validação.
20. **Remoção de vínculos e mandatos:** não há exclusão nem edição de datas pela API (só encerrar vigência de vínculo); correção de dados errados exige procedimento definido.

## Abertas na Fase 4

21. **Situações da emenda:** `rascunho`, `cadastrada` e `cancelada` são rótulos neutros de controle interno, não o rito legal. O fluxo real (análise, aprovação, execução etc.) depende da legislação e fica para a tramitação (Fase 5).
22. **Edição após `cadastrada`:** hoje é permitida (com auditoria e controle de versão). Se a norma exigir travar ou exigir alteração documentada, isso muda.
23. **Dado pessoal em beneficiário:** `documento` de pessoa física é dado pessoal. Falta política de LGPD (base legal, minimização, o que é publicável). Também não há validação de dígitos verificadores de CPF/CNPJ (só formato).
24. **Soma dos beneficiários ≤ valor proposto:** é regra de consistência de dados, não norma jurídica; confirmar se a soma deve ser obrigatoriamente igual ao valor da emenda.
25. **Cancelamento:** irreversível por desenho, sem fluxo de reabertura. Corrigir um cancelamento indevido exigirá procedimento definido.
26. **Versão da emenda:** protege os campos da emenda e a autoria; beneficiários e identificadores externos mudam sem incrementar `versao` (têm trilha própria na auditoria).

## Abertas na Fase 5

27. **Rito e prazos legais:** a tramitação é livre (título, responsável e prazo digitados). O sistema não conhece etapas nem calcula prazos; "atrasada" é só comparação de datas. Modelar o rito real exige validação jurídica.
28. **Responsável como texto:** sem cadastro de usuários/setores (depende de autenticação e papéis).
29. **Critério do plano:** só se confere consistência (há itens; total ≤ valor da emenda). Exigências de conteúdo do plano de trabalho e de análise dependem da norma.
30. **Itens fracionários:** a quantidade é inteira para manter o total exato. Se houver quantidades fracionárias (m², horas), definir a unidade mínima. Há teto técnico de R$ 10 bilhões por item.
31. **Armazenamento de arquivos:** só metadados e SHA-256; falta decidir onde guardar (disco, objeto, retenção, antivírus, backup) e como enviar/baixar com controle de acesso.
32. **Publicação de documentos:** `publicavel` é só um marcador com justificativa; ainda não há portal nem rotina que o utilize. Quem pode publicar depende de papéis.
33. **Plano e execução física:** o realizado de um marco é um registro simples; a execução física completa (medições, evidências) é a Fase 7.
34. **Registros permanentes:** tramitação, diligência, parecer, documento e plano não podem ser apagados, nem corrigidos (só encerrados/cancelados ou substituídos). Falta definir procedimento para correção de erro de digitação.

## Correções da revisão dos PRs 1–4 (migração 0005)

35. **Auditoria da cadeia do plano:** metas, itens e marcos passaram a registrar `emenda_id` (resolvido pela cadeia marco → item → meta → plano → emenda) e um CHECK `NOT VALID` exige isso para novos eventos. Eventos gerados *antes* da 0005 ficam com `emenda_id` nulo, pois a auditoria é append-only e não pode ser corrigida; só existem em bancos de desenvolvimento/homologação criados com a 0004 — sem produção, nada a migrar. Se algum ambiente tiver dados reais, decidir com a Câmara se vale um procedimento controlado de reparo.
36. **Valor da emenda x plano vigente:** reduzir `valor_proposto_centavos` abaixo do total do plano vigente é rejeitado pelo banco (422 na API; valor, versão e plano permanecem). A trava cobre a concorrência com a ativação do plano. Aumentar o valor nunca é bloqueado. Planos em rascunho ou substituídos não bloqueiam a redução, mas um rascunho acima do novo valor só poderá ser ativado depois de ajustado.
