-- Keep outstanding, unused magic links compatible with Better Auth 1.7.
-- Run with application writers stopped. Preserve token identity and expiry.
DO $migration$
DECLARE
  legacy record;
  payload jsonb;
BEGIN
  LOCK TABLE verification IN SHARE ROW EXCLUSIVE MODE;
  FOR legacy IN
    SELECT id, identifier, value
    FROM verification
    WHERE identifier ~ '^[A-Za-z]{32}$'
      AND expires_at > CURRENT_TIMESTAMP
    FOR UPDATE
  LOOP
    BEGIN
      payload := legacy.value::jsonb;
    EXCEPTION WHEN invalid_text_representation OR untranslatable_character
      OR numeric_value_out_of_range THEN
      CONTINUE;
    END;
    -- Only the exact unused legacy magic-link shape is convertible. Other
    -- verification protocols and attempted/ambiguous records remain untouched.
    IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
      OR (payload - ARRAY['email', 'name', 'attempt']) <> '{}'::jsonb
      OR jsonb_typeof(payload->'email') IS DISTINCT FROM 'string'
      OR payload->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR payload->'attempt' IS DISTINCT FROM '0'::jsonb
      OR (payload ? 'name' AND jsonb_typeof(payload->'name') IS DISTINCT FROM 'string')
    THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM verification
      WHERE identifier = 'magic-link:' || legacy.identifier
    ) THEN
      RAISE EXCEPTION 'Resolve legacy magic-link namespace collision before migration';
    END IF;
    UPDATE verification
    SET identifier = 'magic-link:' || legacy.identifier,
        value = ((payload - 'attempt') || '{"type":"magic-link"}'::jsonb)::text
    WHERE id = legacy.id;
  END LOOP;
END
$migration$;
