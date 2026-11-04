-- Núcleo mínimo: exercício, parlamentar, emenda, autoria e auditoria.
-- Valores monetários em centavos inteiros (bigint). Sem regras jurídicas (limites, prazos, bloqueios).

CREATE TABLE exercicio (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ano        integer NOT NULL UNIQUE CHECK (ano BETWEEN 1990 AND 2100),
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parlamentar (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL CHECK (length(btrim(nome)) > 0),
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- ID interno imutável; número oficial e identificadores externos ficam separados.
CREATE TABLE emenda (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exercicio_id            uuid NOT NULL REFERENCES exercicio (id),
  numero_oficial          text CHECK (numero_oficial IS NULL OR length(btrim(numero_oficial)) > 0),
  tipo                    text NOT NULL CHECK (tipo IN ('individual', 'bancada')),
  objeto                  text NOT NULL CHECK (length(btrim(objeto)) > 0),
  valor_proposto_centavos bigint NOT NULL CHECK (valor_proposto_centavos >= 0),
  situacao                text NOT NULL DEFAULT 'rascunho' CHECK (situacao IN ('rascunho')),
  versao                  integer NOT NULL DEFAULT 1,
  criado_em               timestamptz NOT NULL DEFAULT now(),
  atualizado_em           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exercicio_id, numero_oficial)
);

CREATE TABLE emenda_identificador_externo (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id  uuid NOT NULL REFERENCES emenda (id),
  sistema    text NOT NULL CHECK (length(btrim(sistema)) > 0),
  tipo_id    text NOT NULL CHECK (length(btrim(tipo_id)) > 0),
  valor_id   text NOT NULL CHECK (length(btrim(valor_id)) > 0),
  criado_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sistema, tipo_id, valor_id)
);

-- Autoria múltipla. Bancadas e composição histórica ficam para fase posterior.
CREATE TABLE emenda_autoria (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id      uuid NOT NULL REFERENCES emenda (id),
  parlamentar_id uuid NOT NULL REFERENCES parlamentar (id),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (emenda_id, parlamentar_id)
);
CREATE INDEX emenda_autoria_parlamentar_idx ON emenda_autoria (parlamentar_id);
CREATE INDEX emenda_exercicio_idx ON emenda (exercicio_id);

-- Auditoria append-only.
CREATE TABLE auditoria_evento (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entidade    text NOT NULL,
  entidade_id uuid NOT NULL,
  emenda_id   uuid,
  acao        text NOT NULL CHECK (acao IN ('criar', 'alterar', 'remover')),
  antes       jsonb,
  depois      jsonb,
  usuario     text NOT NULL,
  origem      text NOT NULL,
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_evento_emenda_idx ON auditoria_evento (emenda_id, id);
CREATE INDEX auditoria_evento_entidade_idx ON auditoria_evento (entidade, entidade_id, id);

CREATE FUNCTION auditoria_proibir_mudanca() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auditoria_evento é append-only: % não permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER auditoria_evento_sem_update_delete
  BEFORE UPDATE OR DELETE ON auditoria_evento
  FOR EACH ROW EXECUTE FUNCTION auditoria_proibir_mudanca();

CREATE TRIGGER auditoria_evento_sem_truncate
  BEFORE TRUNCATE ON auditoria_evento
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_proibir_mudanca();

-- Registra criação/alteração/remoção. Usuário e origem vêm de app.usuario / app.origem
-- (definidos por transação pela aplicação). Alterações feitas direto no banco também ficam registradas.
CREATE FUNCTION auditoria_registrar() RETURNS trigger LANGUAGE plpgsql AS $$
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

CREATE TRIGGER emenda_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON emenda
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();

CREATE TRIGGER emenda_autoria_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON emenda_autoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();

CREATE TRIGGER emenda_identificador_externo_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON emenda_identificador_externo
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();

-- Emenda: ID imutável, versão incrementada a cada alteração, sem exclusão física.
CREATE FUNCTION emenda_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'emenda.id é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER emenda_antes_update
  BEFORE UPDATE ON emenda
  FOR EACH ROW EXECUTE FUNCTION emenda_antes_de_alterar();

CREATE FUNCTION emenda_proibir_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'emenda não pode ser excluída fisicamente; use cancelamento lógico (fase futura)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER emenda_sem_delete
  BEFORE DELETE ON emenda
  FOR EACH ROW EXECUTE FUNCTION emenda_proibir_delete();
