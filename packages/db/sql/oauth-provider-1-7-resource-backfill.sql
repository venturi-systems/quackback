-- Run only during the documented quiesced 1.6 -> 1.7 rollout, after migration 9005.
-- Set LOCAL quackback.previous_mcp_resource to the exact prior validAudiences entry.
-- Execute inside a transaction. No client secrets, tokens or identity records are returned.
LOCK TABLE oauth_client, oauth_resource, oauth_client_resource IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  resource text := current_setting('quackback.previous_mcp_resource', true);
BEGIN
  IF resource IS NULL OR resource !~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]*)?/api/mcp$' THEN
    RAISE EXCEPTION 'Set the exact previous HTTPS MCP audience before resource backfill';
  END IF;
  IF EXISTS (
    SELECT 1 FROM oauth_client
    WHERE (type IN ('native', 'user-agent-based') AND public IS DISTINCT FROM true)
       OR (type = 'web' AND public = true)
       OR application_type IS NULL OR application_type NOT IN ('web', 'native')
       OR (public IS NOT NULL AND token_endpoint_auth_method IS NOT NULL
           AND public IS DISTINCT FROM (token_endpoint_auth_method = 'none'))
       OR (COALESCE(token_endpoint_auth_method, 'client_secret_basic') IN ('client_secret_basic', 'client_secret_post')
           AND NULLIF(client_secret, '') IS NULL)
       OR COALESCE(token_endpoint_auth_method, 'client_secret_basic') NOT IN ('none', 'client_secret_basic', 'client_secret_post')
  ) THEN
    RAISE EXCEPTION 'Resolve ambiguous legacy OAuth client metadata before rollout; no rows changed';
  END IF;
  IF EXISTS (SELECT 1 FROM oauth_resource WHERE identifier = resource AND disabled = true) THEN
    RAISE EXCEPTION 'The previous MCP resource is disabled; do not re-enable it implicitly';
  END IF;
END $$;

INSERT INTO oauth_resource(id, identifier, name)
SELECT gen_random_uuid()::text, current_setting('quackback.previous_mcp_resource'), 'Quackback MCP'
ON CONFLICT (identifier) DO NOTHING;

-- Before this upgrade every existing client could request the sole MCP audience,
-- subject to its existing scopes and consent. Preserve that authorization only.
INSERT INTO oauth_client_resource(id, client_id, resource_id)
SELECT gen_random_uuid()::text, client_id, current_setting('quackback.previous_mcp_resource')
FROM oauth_client
ON CONFLICT (client_id, resource_id) DO NOTHING;
