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
9. **Cancelamento lógico de emenda:** exclusão física é bloqueada, mas ainda não há fluxo de cancelamento nem situações além de `rascunho` (depende de validação jurídica).
10. ~~Vigência e bancadas~~ — entregue na Fase 3 (ver abaixo).
11. **Hospedagem, backup e implantação:** não decididos; sem deploy nesta fase.
12. **Docker em máquina de desenvolvimento:** o `docker-compose.yml` não pôde ser executado no ambiente desta fase (Docker Desktop não iniciou). A validação local usou PostgreSQL embutido; o CI usa PostgreSQL 16 em contêiner. Conferir o compose em máquina com Docker.
13. **Porta 3000:** reservada/ocupada em algumas máquinas Windows; a porta padrão da API é 3100.
14. Anexos e documentos (armazenamento, classificação interno/publicável) ainda sem modelo implementado.

## Abertas na Fase 3

15. **Quem pode validar parâmetros legais:** hoje qualquer chamada com `X-Usuario` muda o status. Falta perfil (ex.: Controle Interno/Jurídico) e fluxo de aprovação, dependentes de autenticação.
16. **Vínculo de bancada x mandato:** o sistema não exige que o parlamentar tenha mandato vigente para integrar uma bancada. Regra a definir com o Jurídico.
17. **Tipo da emenda x autoria:** emenda `bancada` não exige autor-bancada, nem o contrário. Depende da legislação.
18. **Bancada por exercício:** a bancada pertence a um exercício; se a bancada for permanente entre exercícios, o modelo muda.
19. **Catálogo de códigos de parâmetros:** `codigo` é texto livre; um catálogo (P1 a P8 da matriz jurídica) só deve ser fixado após validação.
20. **Remoção de vínculos e mandatos:** não há exclusão nem edição de datas pela API (só encerrar vigência de vínculo); correção de dados errados exige procedimento definido.
