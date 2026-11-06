-- Fase 6A: núcleo SIMULADO de importação da execução orçamentária e financeira.
--
-- Não há conexão com a IPM nem layout oficial: o formato é NOSSO (ver docs/integracao-ipm/formato-importacao-v1.md).
-- Por segurança, o banco só aceita lotes cuja origem comece com 'SIMULADO-'. Quando existir contrato de dados
-- confirmado com a IPM, essa restrição será removida por uma migração própria e decisão registrada em ADR.
--
-- Estados distintos: empenhado, liquidado e pago vêm daqui; "objeto entregue" (execução física) e "prestação de
-- contas aprovada" NÃO são derivados destes movimentos e não existem nesta fase.

-- ---------------------------------------------------------------- Lotes
CREATE TABLE importacao_lote (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem          text NOT NULL CHECK (origem ~ '^SIMULADO-[A-Z0-9-]{1,40}$'),
  exercicio_id    uuid NOT NULL REFERENCES exercicio (id),
  unidade_gestora text NOT NULL CHECK (length(btrim(unidade_gestora)) > 0),
  data_referencia date NOT NULL,
  formato_versao  integer NOT NULL CHECK (formato_versao = 1),
  arquivo_nome    text,
  arquivo_sha256  text NOT NULL CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  importado_por   text NOT NULL CHECK (length(btrim(importado_por)) > 0),
  total_linhas    integer NOT NULL DEFAULT 0,
  aceitas         integer NOT NULL DEFAULT 0,
  ja_importadas   integer NOT NULL DEFAULT 0,
  divergentes     integer NOT NULL DEFAULT 0,
  rejeitadas      integer NOT NULL DEFAULT 0,
  sem_vinculo     integer NOT NULL DEFAULT 0,
  criado_em       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Movimentos consolidados
-- Escopo da chave: (origem, exercício, unidade gestora, chave na origem). Registros de exercícios ou unidades
-- diferentes com a mesma chave NÃO se confundem.
CREATE TABLE movimento_financeiro (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem               text NOT NULL,
  exercicio_id         uuid NOT NULL REFERENCES exercicio (id),
  unidade_gestora      text NOT NULL,
  chave_origem         text NOT NULL CHECK (length(btrim(chave_origem)) > 0),
  tipo                 text NOT NULL CHECK (tipo IN ('empenho', 'liquidacao', 'pagamento', 'estorno_liquidacao', 'estorno_pagamento')),
  registro_pai_id      uuid REFERENCES movimento_financeiro (id),
  numero               text,
  exercicio_documento  integer CHECK (exercicio_documento IS NULL OR exercicio_documento BETWEEN 1990 AND 2100),
  data_documento       date NOT NULL,
  valor_centavos       bigint NOT NULL CHECK (valor_centavos > 0 AND valor_centavos <= 9007199254740991),
  dotacao              text,
  credor_nome          text,
  identificador_emenda text,
  hash_conteudo        text NOT NULL CHECK (hash_conteudo ~ '^[0-9a-f]{64}$'),
  payload              jsonb NOT NULL,
  primeiro_lote_id     uuid NOT NULL REFERENCES importacao_lote (id),
  criado_em            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origem, exercicio_id, unidade_gestora, chave_origem),
  CHECK ((tipo = 'empenho') = (registro_pai_id IS NULL))
);
CREATE INDEX movimento_financeiro_pai_idx ON movimento_financeiro (registro_pai_id);

-- Resultado por linha de cada lote (inclusive rejeitadas, com os motivos).
CREATE TABLE importacao_linha (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id      uuid NOT NULL REFERENCES importacao_lote (id),
  numero_linha integer NOT NULL CHECK (numero_linha >= 1),
  chave_origem text,
  tipo         text,
  resultado    text NOT NULL CHECK (resultado IN ('aceito', 'ja_importado', 'divergente', 'rejeitado')),
  motivos      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sem_vinculo  boolean NOT NULL DEFAULT false,
  movimento_id uuid REFERENCES movimento_financeiro (id),
  hash_conteudo text,
  payload      jsonb NOT NULL,
  UNIQUE (lote_id, numero_linha),
  CHECK (resultado = 'rejeitado' OR movimento_id IS NOT NULL)
);
CREATE INDEX importacao_linha_movimento_idx ON importacao_linha (movimento_id);

-- ---------------------------------------------------------------- Pendências de conferência
CREATE TABLE importacao_pendencia (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lote_id         uuid NOT NULL REFERENCES importacao_lote (id),
  movimento_id    uuid NOT NULL REFERENCES movimento_financeiro (id),
  tipo            text NOT NULL CHECK (tipo IN ('divergencia_origem', 'sem_vinculo')),
  detalhes        jsonb NOT NULL,
  hash_divergente text CHECK (hash_divergente IS NULL OR hash_divergente ~ '^[0-9a-f]{64}$'),
  situacao        text NOT NULL DEFAULT 'aberta' CHECK (situacao IN ('aberta', 'resolvida')),
  resolucao       text,
  resolvida_por   text,
  resolvida_em    timestamptz,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  CHECK ((situacao = 'aberta') = (resolvida_em IS NULL)),
  CHECK (situacao = 'aberta' OR (length(btrim(coalesce(resolucao, ''))) > 0 AND resolvida_por IS NOT NULL)),
  CHECK ((tipo = 'divergencia_origem') = (hash_divergente IS NOT NULL))
);
-- O mesmo conteúdo divergente não gera pendência duplicada (nem depois de resolvida).
CREATE UNIQUE INDEX importacao_pendencia_divergencia_uq ON importacao_pendencia (movimento_id, hash_divergente)
  WHERE tipo = 'divergencia_origem';
CREATE UNIQUE INDEX importacao_pendencia_sem_vinculo_uq ON importacao_pendencia (movimento_id)
  WHERE tipo = 'sem_vinculo' AND situacao = 'aberta';
CREATE INDEX importacao_pendencia_aberta_idx ON importacao_pendencia (situacao, tipo);

-- ---------------------------------------------------------------- Vínculo movimento x emenda (com rateio)
-- Um movimento pode ser dividido entre várias emendas; a soma dos vínculos ativos não passa do valor do movimento.
-- Decisão sempre registrada (quem, quando, por quê). Vínculo errado não é apagado: é revogado com motivo.
CREATE TABLE movimento_vinculo_emenda (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movimento_id     uuid NOT NULL REFERENCES movimento_financeiro (id),
  emenda_id        uuid NOT NULL REFERENCES emenda (id),
  valor_centavos   bigint NOT NULL CHECK (valor_centavos > 0),
  decisao          text NOT NULL CHECK (decisao IN ('identificador_externo', 'manual')),
  justificativa    text,
  decidido_por     text NOT NULL CHECK (length(btrim(decidido_por)) > 0),
  decidido_em      timestamptz NOT NULL DEFAULT now(),
  revogado_em      timestamptz,
  revogado_por     text,
  revogacao_motivo text,
  CHECK (decisao = 'identificador_externo' OR length(btrim(coalesce(justificativa, ''))) > 0),
  CHECK ((revogado_em IS NULL) = (revogado_por IS NULL) AND (revogado_em IS NULL) = (revogacao_motivo IS NULL)),
  CHECK (revogacao_motivo IS NULL OR length(btrim(revogacao_motivo)) > 0)
);
CREATE UNIQUE INDEX movimento_vinculo_ativo_uq ON movimento_vinculo_emenda (movimento_id, emenda_id) WHERE revogado_em IS NULL;
CREATE INDEX movimento_vinculo_emenda_idx ON movimento_vinculo_emenda (emenda_id);

-- ---------------------------------------------------------------- Travas
-- Movimento: encadeamento coerente e conteúdo imutável.
CREATE FUNCTION movimento_antes_de_inserir() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_pai movimento_financeiro%ROWTYPE;
  v_esperado text;
BEGIN
  IF NEW.tipo = 'empenho' THEN
    RETURN NEW;
  END IF;
  v_esperado := CASE NEW.tipo
    WHEN 'liquidacao' THEN 'empenho'
    WHEN 'pagamento' THEN 'liquidacao'
    WHEN 'estorno_liquidacao' THEN 'liquidacao'
    WHEN 'estorno_pagamento' THEN 'pagamento'
  END;
  SELECT * INTO v_pai FROM movimento_financeiro WHERE id = NEW.registro_pai_id;
  IF v_pai.tipo IS DISTINCT FROM v_esperado THEN
    RAISE EXCEPTION '% deve referenciar registro do tipo % (encontrado: %)', NEW.tipo, v_esperado, coalesce(v_pai.tipo, 'inexistente')
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_pai.origem <> NEW.origem OR v_pai.exercicio_id <> NEW.exercicio_id OR v_pai.unidade_gestora <> NEW.unidade_gestora THEN
    RAISE EXCEPTION 'registro pai pertence a outra origem, exercício ou unidade gestora' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER movimento_financeiro_antes_insert BEFORE INSERT ON movimento_financeiro
  FOR EACH ROW EXECUTE FUNCTION movimento_antes_de_inserir();
CREATE TRIGGER movimento_financeiro_imutavel BEFORE UPDATE OR DELETE ON movimento_financeiro
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER importacao_linha_imutavel BEFORE UPDATE OR DELETE ON importacao_linha
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER importacao_lote_sem_delete BEFORE DELETE ON importacao_lote
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER importacao_pendencia_sem_delete BEFORE DELETE ON importacao_pendencia
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();
CREATE TRIGGER movimento_vinculo_sem_delete BEFORE DELETE ON movimento_vinculo_emenda
  FOR EACH ROW EXECUTE FUNCTION registro_permanente();

-- Pendência: só muda para "resolvida" (uma vez), com resolução; o resto é fixo.
CREATE FUNCTION pendencia_antes_de_alterar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.lote_id IS DISTINCT FROM OLD.lote_id
     OR NEW.movimento_id IS DISTINCT FROM OLD.movimento_id OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.detalhes IS DISTINCT FROM OLD.detalhes OR NEW.hash_divergente IS DISTINCT FROM OLD.hash_divergente THEN
    RAISE EXCEPTION 'conteúdo da pendência é imutável' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.situacao <> 'aberta' THEN
    RAISE EXCEPTION 'pendência já resolvida' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER importacao_pendencia_antes_update BEFORE UPDATE ON importacao_pendencia
  FOR EACH ROW EXECUTE FUNCTION pendencia_antes_de_alterar();

-- Vínculo: emenda congelada se cancelada (trava existente), mesmo exercício, soma <= valor do movimento.
CREATE TRIGGER movimento_vinculo_integridade BEFORE INSERT OR UPDATE ON movimento_vinculo_emenda
  FOR EACH ROW EXECUTE FUNCTION emenda_filho_integridade();

CREATE FUNCTION movimento_vinculo_antes_de_gravar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_valor     bigint;
  v_exercicio uuid;
  v_ex_emenda uuid;
  v_outros    numeric;
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
    RETURN NEW;
  END IF;

  -- NO KEY UPDATE: serializa rateios concorrentes do mesmo movimento sem conflitar com chaves estrangeiras.
  SELECT valor_centavos, exercicio_id INTO v_valor, v_exercicio
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER movimento_vinculo_soma BEFORE INSERT OR UPDATE ON movimento_vinculo_emenda
  FOR EACH ROW EXECUTE FUNCTION movimento_vinculo_antes_de_gravar();

-- ---------------------------------------------------------------- Auditoria
CREATE TRIGGER importacao_lote_auditoria AFTER INSERT OR UPDATE OR DELETE ON importacao_lote
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER movimento_financeiro_auditoria AFTER INSERT OR UPDATE OR DELETE ON movimento_financeiro
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER importacao_pendencia_auditoria AFTER INSERT OR UPDATE OR DELETE ON importacao_pendencia
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
CREATE TRIGGER movimento_vinculo_auditoria AFTER INSERT OR UPDATE OR DELETE ON movimento_vinculo_emenda
  FOR EACH ROW EXECUTE FUNCTION auditoria_registrar();
