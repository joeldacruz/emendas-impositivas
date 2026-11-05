-- Fase 3: mandatos, bancadas com composição histórica, autoria por bancada,
-- fontes normativas e parâmetros legais versionados.
--
-- IMPORTANTE: parâmetros legais NÃO bloqueiam nem calculam nada. Nascem PENDENTE e
-- só viram VALIDADO com validador, data e fonte normativa. Nenhum valor jurídico é semeado.

CREATE TABLE mandato (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlamentar_id uuid NOT NULL REFERENCES parlamentar (id),
  inicio         date NOT NULL,
  fim            date,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CHECK (fim IS NULL OR fim >= inicio)
);
CREATE INDEX mandato_parlamentar_idx ON mandato (parlamentar_id);

CREATE TABLE bancada (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercicio_id uuid NOT NULL REFERENCES exercicio (id),
  nome         text NOT NULL CHECK (length(btrim(nome)) > 0),
  criado_em    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exercicio_id, nome)
);

-- Composição histórica: cada vínculo tem vigência; datas inclusivas.
CREATE TABLE bancada_membro (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bancada_id      uuid NOT NULL REFERENCES bancada (id),
  parlamentar_id  uuid NOT NULL REFERENCES parlamentar (id),
  vigencia_inicio date NOT NULL,
  vigencia_fim    date,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio)
);
CREATE INDEX bancada_membro_bancada_idx ON bancada_membro (bancada_id);
CREATE INDEX bancada_membro_parlamentar_idx ON bancada_membro (parlamentar_id);

CREATE TABLE fonte_normativa (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        text NOT NULL CHECK (length(btrim(tipo)) > 0),
  identificacao text NOT NULL CHECK (length(btrim(identificacao)) > 0),
  referencia  text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parametro_legal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercicio_id        uuid REFERENCES exercicio (id),
  codigo              text NOT NULL CHECK (length(btrim(codigo)) > 0),
  valor               jsonb NOT NULL,
  vigencia_inicio     date NOT NULL,
  vigencia_fim        date,
  fonte_normativa_id  uuid REFERENCES fonte_normativa (id),
  status_validacao    text NOT NULL DEFAULT 'PENDENTE'
                      CHECK (status_validacao IN ('PENDENTE', 'EM_CONFERENCIA', 'VALIDADO', 'NAO_APLICAVEL')),
  validado_por        text,
  validado_em         timestamptz,
  observacao          text,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
  CHECK (status_validacao <> 'VALIDADO'
         OR (validado_por IS NOT NULL AND validado_em IS NOT NULL AND fonte_normativa_id IS NOT NULL))
);
CREATE INDEX parametro_legal_codigo_idx ON parametro_legal (codigo, exercicio_id);

-- Autoria passa a aceitar parlamentar OU bancada (exatamente um por linha).
ALTER TABLE emenda_autoria ALTER COLUMN parlamentar_id DROP NOT NULL;
ALTER TABLE emenda_autoria ADD COLUMN bancada_id uuid REFERENCES bancada (id);
ALTER TABLE emenda_autoria ADD CONSTRAINT emenda_autoria_um_autor
  CHECK (num_nonnulls(parlamentar_id, bancada_id) = 1);
CREATE UNIQUE INDEX emenda_autoria_bancada_uq ON emenda_autoria (emenda_id, bancada_id) WHERE bancada_id IS NOT NULL;
CREATE INDEX emenda_autoria_bancada_idx ON emenda_autoria (bancada_id);

-- Sobreposição de vigências: o banco recusa (com trava por chave para evitar corrida).
CREATE FUNCTION vigencia_sem_sobreposicao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_existe boolean;
BEGIN
  -- Intervalo invertido seria um erro de tipo (daterange) antes do CHECK; recusa com erro de integridade.
  IF TG_TABLE_NAME = 'mandato' THEN
    IF NEW.fim IS NOT NULL AND NEW.fim < NEW.inicio THEN
      RAISE EXCEPTION 'fim do mandato anterior ao início' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.vigencia_fim IS NOT NULL AND NEW.vigencia_fim < NEW.vigencia_inicio THEN
    RAISE EXCEPTION 'fim da vigência anterior ao início (%)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'mandato' THEN
    PERFORM pg_advisory_xact_lock(hashtext('mandato:' || NEW.parlamentar_id));
    SELECT EXISTS (
      SELECT 1 FROM mandato m
      WHERE m.parlamentar_id = NEW.parlamentar_id AND m.id <> NEW.id
        AND daterange(m.inicio, m.fim, '[]') && daterange(NEW.inicio, NEW.fim, '[]')
    ) INTO v_existe;
  ELSIF TG_TABLE_NAME = 'bancada_membro' THEN
    PERFORM pg_advisory_xact_lock(hashtext('membro:' || NEW.bancada_id || NEW.parlamentar_id));
    SELECT EXISTS (
      SELECT 1 FROM bancada_membro m
      WHERE m.bancada_id = NEW.bancada_id AND m.parlamentar_id = NEW.parlamentar_id AND m.id <> NEW.id
        AND daterange(m.vigencia_inicio, m.vigencia_fim, '[]') && daterange(NEW.vigencia_inicio, NEW.vigencia_fim, '[]')
    ) INTO v_existe;
  ELSE
    IF NEW.status_validacao = 'NAO_APLICAVEL' THEN
      RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('param:' || coalesce(NEW.exercicio_id::text, '-') || NEW.codigo));
    SELECT EXISTS (
      SELECT 1 FROM parametro_legal p
      WHERE p.exercicio_id IS NOT DISTINCT FROM NEW.exercicio_id AND p.codigo = NEW.codigo AND p.id <> NEW.id
        AND p.status_validacao <> 'NAO_APLICAVEL'
        AND daterange(p.vigencia_inicio, p.vigencia_fim, '[]') && daterange(NEW.vigencia_inicio, NEW.vigencia_fim, '[]')
    ) INTO v_existe;
  END IF;
  IF v_existe THEN
    RAISE EXCEPTION 'vigência sobrepõe outra já cadastrada (%)', TG_TABLE_NAME
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mandato_vigencia BEFORE INSERT OR UPDATE ON mandato
  FOR EACH ROW EXECUTE FUNCTION vigencia_sem_sobreposicao();
CREATE TRIGGER bancada_membro_vigencia BEFORE INSERT OR UPDATE ON bancada_membro
  FOR EACH ROW EXECUTE FUNCTION vigencia_sem_sobreposicao();
CREATE TRIGGER parametro_legal_vigencia BEFORE INSERT OR UPDATE ON parametro_legal
  FOR EACH ROW EXECUTE FUNCTION vigencia_sem_sobreposicao();

-- Parâmetro legal: o conteúdo é imutável; uma nova versão é uma nova linha.
-- Só podem mudar: fim da vigência, status/validação e observação.
CREATE FUNCTION parametro_legal_conteudo_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.exercicio_id IS DISTINCT FROM OLD.exercicio_id
     OR NEW.codigo IS DISTINCT FROM OLD.codigo
     OR NEW.valor IS DISTINCT FROM OLD.valor
     OR NEW.vigencia_inicio IS DISTINCT FROM OLD.vigencia_inicio
     OR NEW.fonte_normativa_id IS DISTINCT FROM OLD.fonte_normativa_id THEN
    RAISE EXCEPTION 'conteúdo do parâmetro legal é imutável; cadastre nova versão'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER parametro_legal_imutavel BEFORE UPDATE ON parametro_legal
  FOR EACH ROW EXECUTE FUNCTION parametro_legal_conteudo_imutavel();

-- Bancada só serve emendas do mesmo exercício.
CREATE FUNCTION autoria_bancada_mesmo_exercicio() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bancada_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM bancada b JOIN emenda e ON e.exercicio_id = b.exercicio_id
    WHERE b.id = NEW.bancada_id AND e.id = NEW.emenda_id
  ) THEN
    RAISE EXCEPTION 'bancada e emenda devem ser do mesmo exercício'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER emenda_autoria_bancada_exercicio BEFORE INSERT OR UPDATE ON emenda_autoria
  FOR EACH ROW EXECUTE FUNCTION autoria_bancada_mesmo_exercicio();

-- Auditoria para as novas tabelas.
CREATE TRIGGER mandato_auditoria AFTER INSERT OR UPDATE OR DELETE ON mandato
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER bancada_auditoria AFTER INSERT OR UPDATE OR DELETE ON bancada
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER bancada_membro_auditoria AFTER INSERT OR UPDATE OR DELETE ON bancada_membro
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER fonte_normativa_auditoria AFTER INSERT OR UPDATE OR DELETE ON fonte_normativa
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER parametro_legal_auditoria AFTER INSERT OR UPDATE OR DELETE ON parametro_legal
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
