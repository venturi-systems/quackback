# Better Auth 1.7 rollout

This upgrade changes OAuth provider storage, magic-link records and request APIs. A lockfile-only
deployment is unsafe. The application and `@better-auth/oauth-provider` must use
the matching 1.7.15 family.

## Required deployment order

1. Record the exact previous application base URL and its sole
   `validAudiences` entry (`<baseURL>/api/mcp`). Confirm that this is still the
   canonical resource URL. Take the normal database backup.
2. Quiesce the old application and OAuth client registration. Do not run old and
   new token issuers concurrently.
3. Apply the journaled migrations through
   `9006_venturi_magic_link_1_7`. Migration 9005 adds fields and tables, retains all
   old identities and token revocations, and backfills only unambiguous legacy
   client metadata. It does not change account provider IDs or add an issuer.
   Migration 9006 preserves unused, unexpired legacy magic links with the exact
   former record shape, including seven-day invitations, without extending expiry.
   It adds the provider namespace and record type. Namespace collisions stop the
   migration for investigation; other verification records remain unchanged.
   Previously attempted or ambiguous legacy links require normal reissuance.
4. Inventory client metadata without reading client secrets or token values.
   Unknown application types, inconsistent public/authentication flags and
   missing required client secrets must be resolved from the original client
   registration. Do not guess a native type or make an unknown client public.
5. In one transaction, set `quackback.previous_mcp_resource` to the verified
   previous MCP audience and execute
   `packages/db/sql/oauth-provider-1-7-resource-backfill.sql`. The script refuses
   ambiguous client metadata and disabled resources, registers only that
   resource, and adds missing links for existing clients. It preserves existing
   resource policies, client scopes, consent and authentication settings.
   Its precondition is the prior single-MCP-audience configuration; do not use
   it to authorize a new resource.
6. Start the new application. Verify a previously registered client can authorize
   and refresh for the MCP audience; verify newly registered clients receive
   read-only default scopes and that audience only. Verify wrong audiences,
   widened scopes, token replay outside grace, attempts to rotate a revoked
   current grant and DPoP-bound access tokens at the bearer-only MCP endpoint
   fail. A predecessor may replay its already issued response within grace;
   that must not mint tokens, extend expiry or restore a revoked successor.
   Confirm existing IdP callback URLs and linked account IDs are unchanged.
   Verify a retained invitation and a new magic link each sign in the intended
   recipient once. Cancelled links, replayed links and expired links must fail.

For an operator SQL client, step five has this transaction shape (replace the
example with the recorded prior audience, using the client's parameter binding):

```sql
BEGIN;
SELECT set_config('quackback.previous_mcp_resource',
                  'https://quackback.example/api/mcp', true);
-- Execute packages/db/sql/oauth-provider-1-7-resource-backfill.sql here.
COMMIT;
```

The migration and resource backfill are repeatable. Do not remove retained
`oauth_client.public` or `oauth_client.type` columns during this rollout.

## Refresh and rollback constraints

The provider's native rotation-response replay replaces the old un-revoke hook.
A legacy token already marked revoked remains revoked. A refresh failure must
never clear that marker. The configured grace interval now replays the original
rotation response; it does not mint a fresh pair from an old token. An access
token that expires during that interval remains expired (the replay reports
zero remaining lifetime). Clients must retain and use the successor refresh
token. Review this behavior with clients that previously depended on the old
seven-day healing window. During rollout a client may need a fresh authorization
if its previous grant cannot be represented safely.

The schema is additive, but token state written by the new provider is not a
promise of reverse compatibility. Namespaced magic-link records also require
1.7 verification; do not drop the namespace or copy consumed links back into
legacy storage. Before a rollback, stop new issuance and
review the token families created or rotated under 1.7; do not run the old
grace-heal hook over new rotation state. Keep the added columns and tables and
use the normal incident recovery procedure. Do not restore a database snapshot
over newer user data merely to downgrade the package.

## Validation evidence required before merge

Use the pinned Bun 1.4.2 toolchain and frozen lockfile. Run lint, the build before
route-dependent type checking, application tests, database type checking and
the migration tests against a disposable PostgreSQL fixture. The migration
regression creates its own transaction-local schema, checks retained identity
and revoked state, exercises new fields and replay constraints, and verifies
a second migration leaves rows unchanged. Keep the normal required CI checks
and deployment approvals in force.
