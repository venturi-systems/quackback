-- Opt-in semantic routing. No tenant is activated by this migration.
CREATE TABLE IF NOT EXISTS feature_pipeline_boards (
  board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feature_pipeline_capabilities (
  id text PRIMARY KEY,
  tag_id uuid NOT NULL UNIQUE REFERENCES tags(id) ON DELETE RESTRICT,
  visibility text NOT NULL CHECK (visibility IN ('customer','staff')),
  taxonomy_version text NOT NULL,
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  repository_id text NOT NULL CHECK (repository_id ~ '^[0-9]+$'),
  source_repository text NOT NULL,
  source_repository_id text NOT NULL,
  route_policy text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feature_pipeline_links (
  post_id uuid PRIMARY KEY REFERENCES posts(id) ON DELETE RESTRICT,
  capability_id text NOT NULL REFERENCES feature_pipeline_capabilities(id) ON DELETE RESTRICT,
  taxonomy_version text NOT NULL,
  repository text NOT NULL,
  repository_id text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('feature request','enhancement')),
  phase text NOT NULL DEFAULT 'pending' CHECK (phase IN ('pending','creating','linked','held')),
  issue_node_id text UNIQUE,
  issue_number integer CHECK (issue_number > 0),
  issue_url text,
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL,
  baseline_portal text,
  baseline_github text,
  pending_status text,
  last_error text,
  attempted_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository_id, issue_number)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feature_pipeline_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id uuid REFERENCES feature_pipeline_links(post_id) ON DELETE RESTRICT,
  event text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feature_pipeline_audit_post_idx ON feature_pipeline_audit(post_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feature_pipeline_legacy_posts (
  post_id uuid PRIMARY KEY REFERENCES posts(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Deferred checks allow atomic post + tag creation and atomic tag replacement.
-- A missing/multiple route is rejected on EVERY SQL write path, including import.
CREATE OR REPLACE FUNCTION check_feature_pipeline_post(target_post uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE enabled_board boolean; tag_count integer; selected_capability text;
BEGIN
  SELECT b.enabled INTO enabled_board FROM posts p
    JOIN feature_pipeline_boards b ON b.board_id=p.board_id
    WHERE p.id=target_post AND p.deleted_at IS NULL;
  IF NOT COALESCE(enabled_board,false) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM posts p JOIN post_statuses s ON s.id=p.status_id
    WHERE p.id=target_post AND s.deleted_at IS NULL AND s.slug IN
      ('open','under_review','planned','in_progress','complete','closed','declined','withdrawn','deferred','redundant')) THEN
    RAISE EXCEPTION 'Choose a mapped status for this governed request'
      USING ERRCODE='23514', CONSTRAINT='feature_pipeline_status_required';
  END IF;
  SELECT count(*), min(c.id) INTO tag_count, selected_capability
    FROM post_tags pt JOIN feature_pipeline_capabilities c ON c.tag_id=pt.tag_id
    JOIN tags t ON t.id=pt.tag_id
    WHERE pt.post_id=target_post AND c.enabled AND t.deleted_at IS NULL;
  IF tag_count <> 1 THEN
    RAISE EXCEPTION 'Choose exactly one primary capability tag for this feature request'
      USING ERRCODE='23514', CONSTRAINT='feature_pipeline_semantic_tag_required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id
    JOIN feature_pipeline_capabilities c ON
      lower(t.name) IN (lower(c.repository),lower(split_part(c.repository,'/',2)),
                       lower(c.source_repository),lower(split_part(c.source_repository,'/',2)))
    WHERE pt.post_id=target_post
  ) THEN
    RAISE EXCEPTION 'Use customer-facing semantic tags, not repository names'
      USING ERRCODE='23514', CONSTRAINT='feature_pipeline_no_repository_tags';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM feature_pipeline_links WHERE post_id=target_post)
    AND NOT EXISTS (SELECT 1 FROM feature_pipeline_legacy_posts WHERE post_id=target_post) THEN
    RAISE EXCEPTION 'Feature requests must record a durable routing intent in the submission transaction'
      USING ERRCODE='23514', CONSTRAINT='feature_pipeline_intent_required';
  END IF;
  IF EXISTS (SELECT 1 FROM feature_pipeline_links
      WHERE post_id=target_post AND capability_id<>selected_capability) THEN
    RAISE EXCEPTION 'The primary capability is fixed after routing; request staff review'
      USING ERRCODE='23514', CONSTRAINT='feature_pipeline_route_frozen';
  END IF;
  RETURN;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_feature_pipeline_tags() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='posts' THEN
    IF TG_OP='UPDATE' AND NEW.board_id<>OLD.board_id
      AND EXISTS (SELECT 1 FROM feature_pipeline_links WHERE post_id=NEW.id) THEN
      RAISE EXCEPTION 'Routed requests cannot change boards without a reviewed transfer'
        USING ERRCODE='23514', CONSTRAINT='feature_pipeline_board_frozen';
    END IF;
    PERFORM check_feature_pipeline_post(NEW.id);
  ELSE
    IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM check_feature_pipeline_post(OLD.post_id); END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN PERFORM check_feature_pipeline_post(NEW.post_id); END IF;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_post_tags_guard ON post_tags;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_post_tags_guard
AFTER INSERT OR UPDATE OR DELETE ON post_tags DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_tags();
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_posts_guard ON posts;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_posts_guard
AFTER INSERT OR UPDATE ON posts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_tags();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_feature_pipeline_tag_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_post uuid;
BEGIN
  FOR target_post IN SELECT post_id FROM post_tags WHERE tag_id=OLD.id LOOP
    PERFORM check_feature_pipeline_post(target_post);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_tags_guard ON tags;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_tags_guard
AFTER UPDATE ON tags DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_tag_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_feature_pipeline_capability_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_post uuid;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    FOR target_post IN SELECT post_id FROM post_tags WHERE tag_id=OLD.tag_id LOOP
      PERFORM check_feature_pipeline_post(target_post);
    END LOOP;
  END IF;
  IF TG_OP IN ('UPDATE','INSERT') THEN
    FOR target_post IN SELECT post_id FROM post_tags WHERE tag_id=NEW.tag_id LOOP
      PERFORM check_feature_pipeline_post(target_post);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_capabilities_guard ON feature_pipeline_capabilities;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_capabilities_guard
AFTER INSERT OR UPDATE OR DELETE ON feature_pipeline_capabilities DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_capability_mutation();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feature_pipeline_status_outbox (
  event_id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES feature_pipeline_links(post_id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_feature_pipeline_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_post uuid;
BEGIN
  FOR target_post IN SELECT id FROM posts WHERE board_id=NEW.board_id LOOP
    PERFORM check_feature_pipeline_post(target_post);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_activation_guard ON feature_pipeline_boards;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_activation_guard
AFTER INSERT OR UPDATE ON feature_pipeline_boards DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_activation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_feature_pipeline_link_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_feature_pipeline_post(OLD.post_id);
  IF TG_OP='UPDATE' THEN PERFORM check_feature_pipeline_post(NEW.post_id); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_link_guard ON feature_pipeline_links;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_link_guard
AFTER UPDATE OR DELETE ON feature_pipeline_links DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_link_mutation();

--> statement-breakpoint
-- Route/snapshot fields are immutable from intent capture. Once a POST may have
-- occurred, deleting the identity would allow a replacement intent to duplicate it.
CREATE OR REPLACE FUNCTION freeze_feature_pipeline_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.attempted_at IS NOT NULL OR OLD.issue_node_id IS NOT NULL OR OLD.phase='linked' THEN
      RAISE EXCEPTION 'Attempted or linked request identities cannot be deleted'
        USING ERRCODE='23514', CONSTRAINT='feature_pipeline_identity_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.post_id,NEW.capability_id,NEW.taxonomy_version,NEW.repository,NEW.repository_id,
         NEW.classification,NEW.source_snapshot,NEW.source_sha256,NEW.created_at)
    IS DISTINCT FROM
     ROW(OLD.post_id,OLD.capability_id,OLD.taxonomy_version,OLD.repository,OLD.repository_id,
         OLD.classification,OLD.source_snapshot,OLD.source_sha256,OLD.created_at)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.issue_node_id IS NOT NULL AND
      ROW(NEW.issue_node_id,NEW.issue_number,NEW.issue_url)
        IS DISTINCT FROM ROW(OLD.issue_node_id,OLD.issue_number,OLD.issue_url)) THEN
    RAISE EXCEPTION 'Recorded route, source snapshot, and linked issue identity are immutable'
      USING ERRCODE='23514', CONSTRAINT='feature_pipeline_identity_immutable';
  END IF;
  IF NEW.phase='linked' AND (NEW.issue_node_id IS NULL OR NEW.issue_number IS NULL OR NEW.issue_url IS NULL) THEN
    RAISE EXCEPTION 'A linked request requires a complete immutable issue identity';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_identity_guard ON feature_pipeline_links;
--> statement-breakpoint
CREATE TRIGGER feature_pipeline_identity_guard BEFORE UPDATE OR DELETE ON feature_pipeline_links
FOR EACH ROW EXECUTE FUNCTION freeze_feature_pipeline_identity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_feature_pipeline_status_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_post uuid;
BEGIN
  FOR target_post IN SELECT id FROM posts WHERE status_id=OLD.id LOOP
    PERFORM check_feature_pipeline_post(target_post);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS feature_pipeline_status_guard ON post_statuses;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER feature_pipeline_status_guard
AFTER UPDATE ON post_statuses DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_feature_pipeline_status_mutation();
--> statement-breakpoint
ALTER TABLE feature_pipeline_links ADD COLUMN IF NOT EXISTS next_check_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE feature_pipeline_links ADD COLUMN IF NOT EXISTS lease_until timestamptz;
--> statement-breakpoint
ALTER TABLE feature_pipeline_links ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE feature_pipeline_links ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feature_pipeline_links_due_idx ON feature_pipeline_links(next_check_at) WHERE phase<>'held';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS feature_pipeline_api_budget (
  id integer PRIMARY KEY CHECK (id=1),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  requests integer NOT NULL DEFAULT 0,
  paused_until timestamptz
);
--> statement-breakpoint
INSERT INTO feature_pipeline_api_budget(id) VALUES(1) ON CONFLICT DO NOTHING;
