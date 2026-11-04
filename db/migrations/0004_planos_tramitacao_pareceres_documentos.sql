-- Fase 5: planos de trabalho, tramitação neutra, pareceres, diligências e documentos (metadados).
--
-- NEUTRO: nenhum prazo legal, etapa do rito ou critério de análise é codificado. Etapas, prazos e
-- responsáveis são informados por quem opera o sistema. Rito e prazos reais só após validação jurídica.

-- ---------------------------------------------------------------- Planos de trabalho
CREATE TABLE plano_trabalho (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id   uuid NOT NULL REFERENCES emenda (id),
  numero      integer NOT NULL CHECK (numero >= 1),
  situacao    text NOT NULL DEFAULT 'rascunho' CHECK (situacao IN ('rascunho', 'vigente', 'substituido')),
  ativado_em  timestamptz,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (emenda_id, numero),
  CHECK ((situacao = 'rascunho') = (ativado_em IS NULL))
);
-- No máximo um plano vigente por emenda.
CREATE UNIQUE INDEX plano_trabalho_vigente_uq ON plano_trabalho (emenda_id) WHERE situacao = 'vigente';

CREATE TABLE meta (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plano_id  uuid NOT NULL REFERENCES plano_trabalho (id),
  ordem     integer NOT NULL CHECK (ordem >= 1),
  descricao text NOT NULL CHECK (length(btrim(descricao)) > 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plano_id, ordem)
);

-- Quantidade inteira e valor unitário em centavos: o total é exato, sem arredondamento.
CREATE TABLE item_plano (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_id               uuid NOT NULL REFERENCES meta (id),
  ordem                 integer NOT NULL CHECK (ordem >= 1),
  descricao             text NOT NULL CHECK (length(btrim(descricao)) > 0),
  unidade               text NOT NULL CHECK (length(btrim(unidade)) > 0),
  quantidade            bigint NOT NULL CHECK (quantidade >= 1),
  valor_unitario_centavos bigint NOT NULL CHECK (valor_unitario_centavos >= 0),
  -- Teto técnico (R$ 10 bilhões por item) para que totais caibam no inteiro seguro de JavaScript.
  CHECK (quantidade::numeric * valor_unitario_centavos <= 1000000000000),
  criado_em             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meta_id, ordem)
);

CREATE TABLE cronograma_marco (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES item_plano (id),
  descricao    text NOT NULL CHECK (length(btrim(descricao)) > 0),
  previsto_para date NOT NULL,
  realizado_em date,
  criado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cronograma_marco_item_idx ON cronograma_marco (item_id);

-- ---------------------------------------------------------------- Tramitação neutra
CREATE TABLE tramitacao (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id    uuid NOT NULL REFERENCES emenda (id),
  titulo       text NOT NULL CHECK (length(btrim(titulo)) > 0),
  responsavel  text NOT NULL CHECK (length(btrim(responsavel)) > 0),
  prazo        date,
  observacao   text,
  situacao     text NOT NULL DEFAULT 'aberta' CHECK (situacao IN ('aberta', 'concluida', 'cancelada')),
  encerrada_em timestamptz,
  aberta_por   text NOT NULL,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  CHECK ((situacao = 'aberta') = (encerrada_em IS NULL))
);
CREATE INDEX tramitacao_emenda_idx ON tramitacao (emenda_id);

-- ---------------------------------------------------------------- Pareceres e diligências
CREATE TABLE parecer (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id  uuid NOT NULL REFERENCES emenda (id),
  tipo       text NOT NULL CHECK (length(btrim(tipo)) > 0),
  texto      text NOT NULL CHECK (length(btrim(texto)) > 0),
  autor      text NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parecer_emenda_idx ON parecer (emenda_id);

CREATE TABLE diligencia (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id     uuid NOT NULL REFERENCES emenda (id),
  texto         text NOT NULL CHECK (length(btrim(texto)) > 0),
  prazo         date,
  situacao      text NOT NULL DEFAULT 'aberta' CHECK (situacao IN ('aberta', 'atendida', 'cancelada')),
  resposta      text,
  encerrada_em  timestamptz,
  encerrada_por text,
  aberta_por    text NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  CHECK ((situacao = 'aberta') = (encerrada_em IS NULL)),
  CHECK (situacao = 'aberta' OR length(btrim(coalesce(resposta, ''))) > 0)
);
CREATE INDEX diligencia_emenda_idx ON diligencia (emenda_id);

-- ---------------------------------------------------------------- Documentos (somente metadados)
-- O armazenamento do arquivo ainda não foi decidido: guarda-se nome, tamanho e hash SHA-256.
CREATE TABLE documento (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emenda_id                 uuid NOT NULL REFERENCES emenda (id),
  parecer_id                uuid REFERENCES parecer (id),
  diligencia_id             uuid REFERENCES diligencia (id),
  nome_arquivo              text NOT NULL CHECK (length(btrim(nome_arquivo)) > 0),
  tipo_mime                 text NOT NULL CHECK (length(btrim(tipo_mime)) > 0),
  tamanho_bytes             bigint NOT NULL CHECK (tamanho_bytes >= 0),
  sha256                    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  descricao                 text,
  classificacao             text NOT NULL DEFAULT 'interno' CHECK (classificacao IN ('interno', 'publicavel')),
  classificacao_justificativa text,
  registrado_por            text NOT NULL,
  criado_em                 timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(parecer_id, diligencia_id) <= 1)
);
CREATE INDEX documento_emenda_idx ON documento (emenda_id);

-- ---------------------------------------------------------------- Travas
-- Filhos diretos da emenda: congelados se a emenda estiver cancelada.
CREATE TRIGGER plano_trabalho_integridade BEFORE INSERT OR UPDATE OR DELETE ON plano_trabalho
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();
CREATE TRIGGER tramitacao_integridade BEFORE INSERT OR UPDATE OR DELETE ON tramitacao
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();
CREATE TRIGGER parecer_integridade BEFORE INSERT OR UPDATE OR DELETE ON parecer
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();
CREATE TRIGGER diligencia_integridade BEFORE INSERT OR UPDATE OR DELETE ON diligencia
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();
CREATE TRIGGER documento_integridade BEFORE INSERT OR UPDATE OR DELETE ON documento
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();

CREATE FUNCTION registro_permanente() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% é registro permanente: % não permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER plano_trabalho_sem_delete BEFORE DELETE ON plano_trabalho
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER tramitacao_sem_delete BEFORE DELETE ON tramitacao
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER diligencia_sem_delete BEFORE DELETE ON diligencia
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER documento_sem_delete BEFORE DELETE ON documento
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
-- Parecer: nunca editado nem apagado; uma nova opinião é um novo parecer.
CREATE TRIGGER parecer_imutavel BEFORE UPDATE OR DELETE ON parecer
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();

-- Plano: ativação confere itens e total; conteúdo fixo depois.
CREATE FUNCTION plano_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
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
      SELECT count(*), coalesce(sum(i.quantidade::numeric * i.valor_unitario_centavos), 0)
        INTO v_itens, v_total
        FROM item_plano i JOIN meta m ON m.id = i.meta_id WHERE m.plano_id = NEW.id;
      IF v_itens = 0 THEN
        RAISE EXCEPTION 'plano sem itens não pode ser ativado' USING ERRCODE = 'check_violation';
      END IF;
      SELECT valor_proposto_centavos INTO v_valor FROM emenda WHERE id = NEW.emenda_id;
      IF v_total > v_valor THEN
        RAISE EXCEPTION 'total do plano (%) excede o valor proposto da emenda (%)', v_total, v_valor
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER plano_trabalho_antes_update BEFORE UPDATE ON plano_trabalho
  FOR EACH ROW EXECUTE FUNCTION plano_antes_de_alterar();

-- Metas, itens e marcos só mudam com o plano em rascunho (exceção: registrar o realizado de um marco).
CREATE FUNCTION plano_conteudo_editavel() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_plano     uuid;
  v_situacao  text;
  v_emenda    uuid;
  v_ref       jsonb;
  v_so_realizado boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_ref := to_jsonb(OLD);
  ELSE
    v_ref := to_jsonb(NEW);
  END IF;
  IF TG_TABLE_NAME = 'meta' THEN
    v_plano := (v_ref ->> 'plano_id')::uuid;
  ELSIF TG_TABLE_NAME = 'item_plano' THEN
    SELECT plano_id INTO v_plano FROM meta WHERE id = (v_ref ->> 'meta_id')::uuid;
  ELSE
    SELECT m.plano_id INTO v_plano FROM item_plano i JOIN meta m ON m.id = i.meta_id
      WHERE i.id = (v_ref ->> 'item_id')::uuid;
    IF TG_OP = 'UPDATE' THEN
      v_so_realizado := (to_jsonb(NEW) - 'realizado_em') = (to_jsonb(OLD) - 'realizado_em');
    END IF;
  END IF;
  SELECT p.situacao, p.emenda_id INTO v_situacao, v_emenda FROM plano_trabalho p WHERE p.id = v_plano FOR SHARE;
  IF (SELECT situacao FROM emenda WHERE id = v_emenda) = 'cancelada' THEN
    RAISE EXCEPTION 'emenda cancelada não pode ser alterada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_situacao <> 'rascunho' AND NOT (v_so_realizado AND v_situacao = 'vigente') THEN
    RAISE EXCEPTION 'plano % não pode ser alterado: crie nova versão', v_situacao
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meta_editavel BEFORE INSERT OR UPDATE OR DELETE ON meta
  FOR EACH ROW EXECUTE FUNCTION plano_conteudo_editavel();
CREATE TRIGGER item_plano_editavel BEFORE INSERT OR UPDATE OR DELETE ON item_plano
  FOR EACH ROW EXECUTE FUNCTION plano_conteudo_editavel();
CREATE TRIGGER cronograma_marco_editavel BEFORE INSERT OR UPDATE OR DELETE ON cronograma_marco
  FOR EACH ROW EXECUTE FUNCTION plano_conteudo_editavel();

-- Tramitação: só encerra (conclui ou cancela); texto fixo.
CREATE FUNCTION tramitacao_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.emenda_id IS DISTINCT FROM OLD.emenda_id
     OR NEW.titulo IS DISTINCT FROM OLD.titulo OR NEW.responsavel IS DISTINCT FROM OLD.responsavel
     OR NEW.prazo IS DISTINCT FROM OLD.prazo OR NEW.observacao IS DISTINCT FROM OLD.observacao
     OR NEW.aberta_por IS DISTINCT FROM OLD.aberta_por THEN
    RAISE EXCEPTION 'conteúdo da tramitação é imutável; cancele e registre outra'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.situacao <> 'aberta' THEN
    RAISE EXCEPTION 'tramitação já encerrada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tramitacao_antes_update BEFORE UPDATE ON tramitacao
  FOR EACH ROW EXECUTE FUNCTION tramitacao_antes_de_alterar();

CREATE FUNCTION diligencia_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.emenda_id IS DISTINCT FROM OLD.emenda_id
     OR NEW.texto IS DISTINCT FROM OLD.texto OR NEW.prazo IS DISTINCT FROM OLD.prazo
     OR NEW.aberta_por IS DISTINCT FROM OLD.aberta_por THEN
    RAISE EXCEPTION 'conteúdo da diligência é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.situacao <> 'aberta' THEN
    RAISE EXCEPTION 'diligência já encerrada' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER diligencia_antes_update BEFORE UPDATE ON diligencia
  FOR EACH ROW EXECUTE FUNCTION diligencia_antes_de_alterar();

-- Documento: só a classificação muda, sempre com justificativa.
CREATE FUNCTION documento_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.emenda_id IS DISTINCT FROM OLD.emenda_id
     OR NEW.parecer_id IS DISTINCT FROM OLD.parecer_id OR NEW.diligencia_id IS DISTINCT FROM OLD.diligencia_id
     OR NEW.nome_arquivo IS DISTINCT FROM OLD.nome_arquivo OR NEW.tipo_mime IS DISTINCT FROM OLD.tipo_mime
     OR NEW.tamanho_bytes IS DISTINCT FROM OLD.tamanho_bytes OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.descricao IS DISTINCT FROM OLD.descricao OR NEW.registrado_por IS DISTINCT FROM OLD.registrado_por THEN
    RAISE EXCEPTION 'metadados do documento são imutáveis; só a classificação pode mudar'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.classificacao IS DISTINCT FROM OLD.classificacao
     AND (length(btrim(coalesce(NEW.classificacao_justificativa, ''))) = 0
          OR NEW.classificacao_justificativa IS NOT DISTINCT FROM OLD.classificacao_justificativa) THEN
    RAISE EXCEPTION 'mudança de classificação exige justificativa nova' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documento_antes_update BEFORE UPDATE ON documento
  FOR EACH ROW EXECUTE FUNCTION documento_antes_de_alterar();

-- ---------------------------------------------------------------- Auditoria
CREATE TRIGGER plano_trabalho_auditoria AFTER INSERT OR UPDATE OR DELETE ON plano_trabalho
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER meta_auditoria AFTER INSERT OR UPDATE OR DELETE ON meta
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER item_plano_auditoria AFTER INSERT OR UPDATE OR DELETE ON item_plano
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER cronograma_marco_auditoria AFTER INSERT OR UPDATE OR DELETE ON cronograma_marco
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER tramitacao_auditoria AFTER INSERT OR UPDATE OR DELETE ON tramitacao
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER parecer_auditoria AFTER INSERT OR UPDATE OR DELETE ON parecer
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER diligencia_auditoria AFTER INSERT OR UPDATE OR DELETE ON diligencia
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER documento_auditoria AFTER INSERT OR UPDATE OR DELETE ON documento
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
