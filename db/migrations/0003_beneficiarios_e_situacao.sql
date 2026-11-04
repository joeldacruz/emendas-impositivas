-- Fase 4: beneficiários, cancelamento lógico e travas de integridade da emenda.
-- Sem regras jurídicas: as travas abaixo protegem a consistência dos dados (soma, estado, histórico).

CREATE TABLE beneficiario (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL CHECK (length(btrim(nome)) > 0),
  tipo       text NOT NULL CHECK (tipo IN ('pessoa_juridica', 'pessoa_fisica', 'orgao_publico', 'outro')),
  -- Dado pessoal quando pessoa física (LGPD): só dígitos; nunca exposto em dados publicáveis sem decisão jurídica.
  documento  text CHECK (documento IS NULL OR documento ~ '^[0-9]{11}$' OR documento ~ '^[0-9]{14}$'),
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX beneficiario_documento_uq ON beneficiario (documento) WHERE documento IS NOT NULL;

CREATE TABLE emenda_beneficiario (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id       uuid NOT NULL REFERENCES emenda (id),
  beneficiario_id uuid NOT NULL REFERENCES beneficiario (id),
  valor_centavos  bigint CHECK (valor_centavos IS NULL OR valor_centavos >= 0),
  criado_em       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (emenda_id, beneficiario_id)
);
CREATE INDEX emenda_beneficiario_beneficiario_idx ON emenda_beneficiario (beneficiario_id);

-- Situação: rascunho -> cadastrada -> cancelada (lógico, irreversível, com motivo).
ALTER TABLE emenda DROP CONSTRAINT emenda_situacao_check;
ALTER TABLE emenda ADD CONSTRAINT emenda_situacao_check CHECK (situacao IN ('rascunho', 'cadastrada', 'cancelada'));
ALTER TABLE emenda ADD COLUMN cancelada_em timestamptz;
ALTER TABLE emenda ADD COLUMN cancelamento_motivo text;
ALTER TABLE emenda ADD CONSTRAINT emenda_cancelamento_coerente CHECK (
  (situacao = 'cancelada' AND cancelada_em IS NOT NULL AND length(btrim(coalesce(cancelamento_motivo, ''))) > 0)
  OR (situacao <> 'cancelada' AND cancelada_em IS NULL AND cancelamento_motivo IS NULL)
);

-- Transições válidas e emenda cancelada congelada.
CREATE OR REPLACE FUNCTION emenda_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_soma bigint;
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
  END IF;
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$;

-- Filhos da emenda: bloqueados quando cancelada; soma dos beneficiários não passa do valor proposto.
CREATE FUNCTION emenda_filho_integridade() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_emenda    uuid;
  v_situacao  text;
  v_valor     bigint;
  v_soma      bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_emenda := OLD.emenda_id;
  ELSE
    v_emenda := NEW.emenda_id;
  END IF;
  SELECT situacao, valor_proposto_centavos INTO v_situacao, v_valor FROM emenda WHERE id = v_emenda FOR UPDATE;
  IF v_situacao = 'cancelada' THEN
    RAISE EXCEPTION 'emenda cancelada não pode ser alterada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_TABLE_NAME = 'emenda_beneficiario' AND TG_OP <> 'DELETE' THEN
    SELECT coalesce(sum(valor_centavos), 0) INTO v_soma FROM emenda_beneficiario
      WHERE emenda_id = v_emenda AND id <> NEW.id;
    IF v_soma + coalesce(NEW.valor_centavos, 0) > v_valor THEN
      RAISE EXCEPTION 'soma destinada aos beneficiários (%) excede o valor proposto (%)',
        v_soma + coalesce(NEW.valor_centavos, 0), v_valor USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER emenda_autoria_integridade BEFORE INSERT OR UPDATE OR DELETE ON emenda_autoria
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();
CREATE TRIGGER emenda_beneficiario_integridade BEFORE INSERT OR UPDATE OR DELETE ON emenda_beneficiario
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();
CREATE TRIGGER emenda_identificador_integridade BEFORE INSERT OR UPDATE OR DELETE ON emenda_identificador_externo
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();

CREATE TRIGGER beneficiario_auditoria AFTER INSERT OR UPDATE OR DELETE ON beneficiario
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER emenda_beneficiario_auditoria AFTER INSERT OR UPDATE OR DELETE ON emenda_beneficiario
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
