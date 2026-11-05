-- Correções da revisão dos PRs 1–4. Não reescreve migrações anteriores: substitui funções por CREATE OR REPLACE.
--
-- 1) Auditoria: metas, itens e marcos não têm coluna emenda_id; o evento ficava com emenda_id NULL e não
--    aparecia em GET /emendas/:id/auditoria. Passa a ser resolvido pela cadeia marco -> item -> meta -> plano -> emenda.
-- 2) Valor da emenda não pode ser reduzido abaixo do total do plano de trabalho vigente, com trava de
--    concorrência entre a ativação do plano e a alteração do valor.

-- ---------------------------------------------------------------- 1) Auditoria
CREATE OR REPLACE FUNCTION auditoria_registrar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_antes  jsonb;
  v_depois jsonb;
  v_linha  jsonb;
  v_emenda uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_depois := to_jsonb(NEW);
    v_linha := v_depois;
  ELSIF TG_OP = 'UPDATE' THEN
    v_antes := to_jsonb(OLD);
    v_depois := to_jsonb(NEW);
    v_linha := v_depois;
    IF v_antes = v_depois THEN
      RETURN NULL;
    END IF;
  ELSE
    v_antes := to_jsonb(OLD);
    v_linha := v_antes;
  END IF;

  IF TG_TABLE_NAME = 'emenda' THEN
    v_emenda := (v_linha ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME = 'meta' THEN
    SELECT p.emenda_id INTO v_emenda FROM plano_trabalho p WHERE p.id = (v_linha ->> 'plano_id')::uuid;
  ELSIF TG_TABLE_NAME = 'item_plano' THEN
    SELECT p.emenda_id INTO v_emenda
      FROM meta m JOIN plano_trabalho p ON p.id = m.plano_id
     WHERE m.id = (v_linha ->> 'meta_id')::uuid;
  ELSIF TG_TABLE_NAME = 'cronograma_marco' THEN
    SELECT p.emenda_id INTO v_emenda
      FROM item_plano i JOIN meta m ON m.id = i.meta_id JOIN plano_trabalho p ON p.id = m.plano_id
     WHERE i.id = (v_linha ->> 'item_id')::uuid;
  ELSE
    v_emenda := (v_linha ->> 'emenda_id')::uuid;
  END IF;

  INSERT INTO auditoria_evento (entidade, entidade_id, emenda_id, acao, antes, depois, usuario, origem)
  VALUES (
    TG_TABLE_NAME,
    (v_linha ->> 'id')::uuid,
    v_emenda,
    CASE TG_OP WHEN 'INSERT' THEN 'criar' WHEN 'UPDATE' THEN 'alterar' ELSE 'remover' END,
    v_antes,
    v_depois,
    coalesce(nullif(current_setting('app.usuario', true), ''), 'desconhecido'),
    coalesce(nullif(current_setting('app.origem', true), ''), 'direto-no-banco')
  );
  RETURN NULL;
END;
$$;

-- Rede de segurança: eventos da cadeia do plano passam a exigir emenda_id. NOT VALID porque a tabela de
-- auditoria é append-only (eventos antigos não podem ser corrigidos); vale para todo evento novo.
ALTER TABLE auditoria_evento ADD CONSTRAINT auditoria_cadeia_do_plano_exige_emenda
  CHECK (entidade NOT IN ('plano_trabalho', 'meta', 'item_plano', 'cronograma_marco') OR emenda_id IS NOT NULL) NOT VALID;

-- ---------------------------------------------------------------- 2) Valor da emenda x plano vigente
-- Ativação do plano: trava a emenda ANTES de ler o valor (a ordem alfabética dos gatilhos fazia a leitura
-- acontecer antes do bloqueio da emenda por emenda_filho_integridade).
CREATE OR REPLACE FUNCTION plano_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total  numeric;
  v_itens  integer;
  v_valor  bigint;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.emenda_id IS DISTINCT FROM OLD.emenda_id
     OR NEW.numero IS DISTINCT FROM OLD.numero THEN
    RAISE EXCEPTION 'identidade do plano é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.situacao <> OLD.situacao THEN
    IF NOT ((OLD.situacao = 'rascunho' AND NEW.situacao = 'vigente')
         OR (OLD.situacao = 'vigente' AND NEW.situacao = 'substituido')) THEN
      RAISE EXCEPTION 'transição de plano inválida: % -> %', OLD.situacao, NEW.situacao
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.situacao = 'vigente' THEN
      -- FOR UPDATE (e não FOR SHARE): evita impasse de promoção de trava entre duas ativações concorrentes.
      SELECT valor_proposto_centavos INTO v_valor FROM emenda WHERE id = NEW.emenda_id FOR UPDATE;
      SELECT count(*), coalesce(sum(i.quantidade::numeric * i.valor_unitario_centavos), 0)
        INTO v_itens, v_total
        FROM item_plano i JOIN meta m ON m.id = i.meta_id WHERE m.plano_id = NEW.id;
      IF v_itens = 0 THEN
        RAISE EXCEPTION 'plano sem itens não pode ser ativado' USING ERRCODE = 'check_violation';
      END IF;
      IF v_total > v_valor THEN
        RAISE EXCEPTION 'total do plano (%) excede o valor proposto da emenda (%)', v_total, v_valor
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Alteração da emenda: a redução do valor não pode ficar abaixo do total do plano vigente.
-- (O gatilho roda com a linha da emenda já travada; a ativação concorrente espera esse bloqueio.)
CREATE OR REPLACE FUNCTION emenda_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_soma  bigint;
  v_plano numeric;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'emenda.id é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.situacao = 'cancelada' THEN
    RAISE EXCEPTION 'emenda cancelada não pode ser alterada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.situacao <> OLD.situacao AND NOT (
       (OLD.situacao = 'rascunho' AND NEW.situacao IN ('cadastrada', 'cancelada'))
    OR (OLD.situacao = 'cadastrada' AND NEW.situacao = 'cancelada')
  ) THEN
    RAISE EXCEPTION 'transição de situação inválida: % -> %', OLD.situacao, NEW.situacao
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.valor_proposto_centavos < OLD.valor_proposto_centavos THEN
    SELECT coalesce(sum(valor_centavos), 0) INTO v_soma FROM emenda_beneficiario WHERE emenda_id = NEW.id;
    IF v_soma > NEW.valor_proposto_centavos THEN
      RAISE EXCEPTION 'valor proposto (%) menor que a soma destinada aos beneficiários (%)',
        NEW.valor_proposto_centavos, v_soma USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(i.quantidade::numeric * i.valor_unitario_centavos), 0) INTO v_plano
      FROM plano_trabalho p
      JOIN meta m ON m.plano_id = p.id
      JOIN item_plano i ON i.meta_id = m.id
     WHERE p.emenda_id = NEW.id AND p.situacao = 'vigente';
    IF v_plano > NEW.valor_proposto_centavos THEN
      RAISE EXCEPTION 'valor proposto (%) menor que o total do plano de trabalho vigente (%)',
        NEW.valor_proposto_centavos, v_plano USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$;
