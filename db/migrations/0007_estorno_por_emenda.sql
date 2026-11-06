-- Correções da revisão do PR 5 (Fase 6A). Não edita migrações anteriores.
--
-- Estorno x rateio: um estorno só pode abater, em cada emenda, a parcela do movimento ORIGINAL alocada a essa mesma
-- emenda, somados os estornos já alocados a ela. Do contrário, a emenda A mostraria o pagamento integral enquanto a
-- emenda B mostraria pago líquido negativo.

-- ---------------------------------------------------------------- Pendência: novo tipo, ligado à emenda afetada
ALTER TABLE importacao_pendencia DROP CONSTRAINT importacao_pendencia_tipo_check;
ALTER TABLE importacao_pendencia ADD CONSTRAINT importacao_pendencia_tipo_check
  CHECK (tipo IN ('divergencia_origem', 'sem_vinculo', 'estorno_sem_alocacao_compativel'));
ALTER TABLE importacao_pendencia ADD COLUMN emenda_id uuid REFERENCES emenda (id);
ALTER TABLE importacao_pendencia ADD CONSTRAINT importacao_pendencia_emenda_coerente
  CHECK ((tipo = 'estorno_sem_alocacao_compativel') = (emenda_id IS NOT NULL));
CREATE UNIQUE INDEX importacao_pendencia_estorno_uq ON importacao_pendencia (movimento_id, emenda_id)
  WHERE tipo = 'estorno_sem_alocacao_compativel' AND situacao = 'aberta';
CREATE INDEX importacao_pendencia_emenda_idx ON importacao_pendencia (emenda_id) WHERE emenda_id IS NOT NULL;

CREATE OR REPLACE FUNCTION pendencia_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.lote_id IS DISTINCT FROM OLD.lote_id
     OR NEW.movimento_id IS DISTINCT FROM OLD.movimento_id OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.emenda_id IS DISTINCT FROM OLD.emenda_id
     OR NEW.detalhes IS DISTINCT FROM OLD.detalhes OR NEW.hash_divergente IS DISTINCT FROM OLD.hash_divergente THEN
    RAISE EXCEPTION 'conteúdo da pendência é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.situacao <> 'aberta' THEN
    RAISE EXCEPTION 'pendência já resolvida' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- Vínculo: regra de estorno por emenda
-- Ordem de travas (sempre a mesma, para evitar impasse): emenda (gatilho de integridade) -> movimento do vínculo -> movimento original.
CREATE OR REPLACE FUNCTION movimento_vinculo_antes_de_gravar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_valor     bigint;
  v_exercicio uuid;
  v_ex_emenda uuid;
  v_outros    numeric;
  v_tipo      text;
  v_pai       uuid;
  v_parcela   numeric;
  v_estornos  numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- só é permitido revogar (uma vez); nada mais muda
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.movimento_id IS DISTINCT FROM OLD.movimento_id
       OR NEW.emenda_id IS DISTINCT FROM OLD.emenda_id OR NEW.valor_centavos IS DISTINCT FROM OLD.valor_centavos
       OR NEW.decisao IS DISTINCT FROM OLD.decisao OR NEW.justificativa IS DISTINCT FROM OLD.justificativa
       OR NEW.decidido_por IS DISTINCT FROM OLD.decidido_por OR NEW.decidido_em IS DISTINCT FROM OLD.decidido_em THEN
      RAISE EXCEPTION 'vínculo só pode ser revogado; corrija com novo vínculo' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.revogado_em IS NOT NULL THEN
      RAISE EXCEPTION 'vínculo já revogado' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- Revogar a parcela do ORIGINAL não pode deixar estornos vinculados à mesma emenda sem lastro:
    -- revogue primeiro os vínculos dos estornos.
    PERFORM 1 FROM movimento_financeiro WHERE id = NEW.movimento_id FOR NO KEY UPDATE;
    IF EXISTS (
      SELECT 1
        FROM movimento_vinculo_emenda ve
        JOIN movimento_financeiro f ON f.id = ve.movimento_id
       WHERE f.registro_pai_id = NEW.movimento_id
         AND f.tipo IN ('estorno_liquidacao', 'estorno_pagamento')
         AND ve.emenda_id = NEW.emenda_id
         AND ve.revogado_em IS NULL
    ) THEN
      RAISE EXCEPTION 'o vínculo do movimento original possui estornos vinculados à mesma emenda; revogue antes os vínculos dos estornos'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- NO KEY UPDATE: serializa rateios concorrentes do mesmo movimento sem conflitar com chaves estrangeiras.
  SELECT valor_centavos, exercicio_id, tipo, registro_pai_id INTO v_valor, v_exercicio, v_tipo, v_pai
    FROM movimento_financeiro WHERE id = NEW.movimento_id FOR NO KEY UPDATE;
  SELECT exercicio_id INTO v_ex_emenda FROM emenda WHERE id = NEW.emenda_id;
  IF v_ex_emenda IS DISTINCT FROM v_exercicio THEN
    RAISE EXCEPTION 'a emenda pertence a outro exercício que o movimento' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(valor_centavos), 0) INTO v_outros
    FROM movimento_vinculo_emenda WHERE movimento_id = NEW.movimento_id AND revogado_em IS NULL;
  IF v_outros + NEW.valor_centavos > v_valor THEN
    RAISE EXCEPTION 'rateio (% + %) excede o valor do movimento (%)', v_outros, NEW.valor_centavos, v_valor
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tipo IN ('estorno_liquidacao', 'estorno_pagamento') THEN
    PERFORM 1 FROM movimento_financeiro WHERE id = v_pai FOR NO KEY UPDATE;
    SELECT coalesce(sum(valor_centavos), 0) INTO v_parcela
      FROM movimento_vinculo_emenda
     WHERE movimento_id = v_pai AND emenda_id = NEW.emenda_id AND revogado_em IS NULL;
    SELECT coalesce(sum(ve.valor_centavos), 0) INTO v_estornos
      FROM movimento_vinculo_emenda ve
      JOIN movimento_financeiro f ON f.id = ve.movimento_id
     WHERE f.registro_pai_id = v_pai AND f.tipo = v_tipo AND ve.emenda_id = NEW.emenda_id AND ve.revogado_em IS NULL;
    IF v_estornos + NEW.valor_centavos > v_parcela THEN
      RAISE EXCEPTION 'estorno (% + % já alocados) excede a parcela do movimento original alocada a esta emenda (%)',
        NEW.valor_centavos, v_estornos, v_parcela USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
