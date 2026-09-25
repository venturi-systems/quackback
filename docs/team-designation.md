# Team designation

Owner decisions 6 and 7 on venturi-systems/landing-page#2309 (2026-09-22).

## The rule

Anyone who signs up with Google or GitHub is a **Contributor**: they can read
the portal (subject to board access), submit, vote and comment.

Only a designated person holds a team role:

| Role                    | Can do                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Team member (`member`)  | Review posts, set status, move roadmap items, merge duplicates, publish the changelog, create and rename boards |
| Administrator (`admin`) | Everything a team member can, plus settings, board deletion and access, team roles, API keys and webhooks       |

A team role takes effect only for an account that:

1. has a Google or GitHub account linked (never the password credential alone,
   never a magic link, a widget identify or an OIDC provider),
2. whose email address is marked verified on the account, and
3. whose address is at a domain in `VENTURI_TEAM_EMAIL_DOMAINS` (default
   `venturi.systems`; exact hostnames, subdomains never match).

What rule 2 reads is the account's own verified flag. These keep it honest:

- Google and GitHub are **not** trusted linking providers
  (`lib/server/auth/linking-trust.ts`). They attach to an existing account
  only when they report the address verified and the account is already
  verified, so a provider identity with an unverified address can never sign
  in as someone else's account.
- The REST API cannot set the flag of a team account or a team-domain address,
  and cannot create an account at a team domain (`user.identify.ts`,
  `TEAM_IDENTITY_LOCKED`). That account is created by its owner's first Google
  or GitHub sign-in.
- Nothing else creates an account at a team domain either: Admin > Users
  refuses a team-domain address on a new or edited portal user (leave the email
  empty, or invite the person), a CSV import attributes an unknown team-domain
  author to the importer, and feedback ingestion leaves such an author
  unresolved or keyed by its external id. An unverified row on that address
  would otherwise block the owner's own Google or GitHub sign-in, because
  Better Auth links only onto a verified account.
- The admin UI cannot edit a team member's address (`TEAM_EMAIL_LOCKED`).
- A sign-in method the workspace has switched off (password, magic link) is
  refused for brand-new addresses as well as known ones, so nobody can create a
  password account that would sit on a future team member's address
  (`auth/hooks.ts`, `handleSignInPreCheck`).
- A password sign-up at a team-domain address is refused even while password
  sign-in is switched on (`auth/hooks.ts`, `team_identity_required`). The row
  it would leave carries a password its creator knows: once the real owner
  verified the address by magic link and linked Google or GitHub, that
  password would open an account that holds a team role.
- A Google, GitHub or other social sign-in that would create or open an account
  at a team domain whose address is not verified is refused, and a
  just-created account is removed again (`auth/hooks.ts`,
  `team_email_unverified`). Otherwise a provider account that reported the
  address unverified would stay linked to the row, and the real owner's later
  magic-link sign-in (a team invitation link, for example) would mark the row
  verified and hand that provider account a team seat.
- An anonymous visitor who then signs up keeps the new account's own verified
  flag, never a blanket "verified" (`auth/merge-anonymous.ts`,
  `absorbedSignUpIdentity`).

The server checks the rule when a role is assigned **and** on every team or
administrator action (`lib/server/domains/principals/team-identity.ts`,
`session-role.ts`). A stored team role on an account that fails the rule acts
as a Contributor; Admin > Team marks it "Inactive" with the reason.

API keys follow the same rule: a key acts with the lower of its stored role
and its creator's current role, so a key made by an account that no longer
qualifies loses its team authority. No API key and no MCP client can change a
post's status.

Every API key is scoped and expires (`lib/shared/api-key-scopes.ts`,
`domains/api-keys/api-key.service.ts`). A key created before that can lack
both. The release that carries this rule bounds every such key once, when its
database migration runs
(`packages/db/drizzle/9003_venturi_legacy_api_key_bounds.sql`):

- a key with no API scope can only read feedback and help articles
  (`read:feedback` and `read:article`, the "Read only" preset). It keeps any
  internal capability scope. A read-only integration keeps working; one that
  wrote needs a new key.
- a key with no expiry expires 90 days after the migration, the default
  lifetime of a new key. That is the notice to replace it.
- a key whose expiry is more than a year and a day away expires a year after
  the migration, the longest lifetime a new key may have.
- `api_keys.legacy_bounded_at` records when. Admin > Settings > Developers >
  API Keys shows a notice above the list and a line on each such key.

The code applies the same bounds to any key the migration never saw: a key
stored without an API scope reads only, never full access, and one stored
without an expiry stops working 365 days after it was created. Before this
rule, such a key was bounded only by its role and its creator's role. A key
stored without scopes or without an expiry cannot be rotated, because rotation
keeps a key's scopes and expiry and would only renew its secret; neither can
an expired key. A bounded key has both, so it rotates, keeping its read-only
scopes and its expiry. Replace any of them with a new scoped key (cutover step 4).

## Designation sources

- **`VENTURI_TEAM_ADMIN_EMAILS`** (comma-separated). A listed address becomes
  an administrator at its next Google or GitHub sign-in, or on the next
  authenticated request of a session it already has, once it satisfies the
  rule. The list only promotes; removing an address demotes no one.
- **Admin > Team.** An administrator designates an account that already
  signed in and satisfies the rule ("Accounts ready to designate"), or invites
  a team-domain address. An invitation applies automatically at the invitee's
  first Google or GitHub sign-in with that address. The server refuses an
  invitation or a promotion for any other address.

Every write that gives or takes away a team role reads the principal, checks
the rules and writes in one transaction that holds the team-role advisory lock
(`team-role-lock.ts`): Admin > Team, invitations, the
`VENTURI_TEAM_ADMIN_EMAILS` promotion and SSO auto-provisioning
(`team-designation.ts`), and the onboarding and first-SSO bootstrap claims,
which take their own bootstrap lock first. So a role another writer set a
moment earlier is the one the rules check:

- a promotion needs a qualifying identity;
- taking `admin` away needs another administrator who satisfies the rule, so
  no path leaves the workspace without an administrator who can act;
- nobody changes or removes their own role;
- unlinking the last Google or GitHub account of the only such administrator
  is refused.

The unlink check runs before Better Auth unlinks, not in the same transaction:
two administrators who each unlink their last Google or GitHub account at the
same moment can both pass it. Either recovers without break-glass by signing
in with Google or GitHub again, which links the provider back onto the
verified account.

## Cutover after deploy (feedback.venturi.systems)

The feedback infrastructure repository delivers `VENTURI_TEAM_ADMIN_EMAILS`
and `VENTURI_TEAM_EMAIL_DOMAINS` (venturi-systems/feedback#209). Its release
runbook (`docs/design-rollout-readiness.md#release-runbook`) owns the order;
the fork-side steps are:

1. **Read the roles** (read-only SQL, runbook step 8): the password bootstrap
   administrator is `admin` with an unverified address and no Google or GitHub
   link, so under this release it already acts as a Contributor.
   In the same read, list team-domain accounts whose address is unverified
   but that carry a `google` or `github` link:

   ```sql
   SELECT u.id, u.email, a.provider_id, u.created_at
   FROM "user" u JOIN account a ON a.user_id = u.id
   WHERE a.provider_id IN ('google', 'github')
     AND u.email_verified = false
     AND lower(split_part(u.email, '@', 2)) = 'venturi.systems';
   ```

   This release refuses such a sign-in, so a row of that shape predates it.
   Review each one (and remove it if nobody on the team owns it) before
   inviting that address: an invitation link would mark the row verified and
   give its linked provider account the invited role.

   Also list team-domain accounts that carry a password:

   ```sql
   SELECT u.id, u.email, u.email_verified, u.created_at
   FROM "user" u JOIN account a ON a.user_id = u.id
   WHERE a.provider_id = 'credential'
     AND lower(split_part(u.email, '@', 2)) = 'venturi.systems';
   ```

   This release refuses a password sign-up at a team domain, so apart from the
   bootstrap account such a row predates it. Review each one the same way:
   whenever password sign-in is switched on, its password still opens the
   account after the owner has linked Google or GitHub to it.

2. **Promote** (runbook step 9): the designated owner signs in with Google or
   GitHub. The sign-in hook promotes the account to `admin`; an already open
   session is promoted on its next request. Pass: the account is `admin` with
   `google` or `github` among its providers, Admin > Team shows it active.
3. **Demote the bootstrap account** (runbook step 10): in Admin > Team, the
   owner removes the bootstrap account's team role. The server allows it
   because another qualifying administrator exists.
4. **Replace keys made before scopes and expiry** (read-only SQL, then Admin >
   Settings > Developers > API Keys, after step 2). The migration has already
   limited each such key to reading and given it an expiry. List the active
   keys it bounded, and any it could not see:

   ```sql
   SELECT id, name, key_prefix, created_at, last_used_at, expires_at,
          legacy_bounded_at, scopes
   FROM api_keys
   WHERE revoked_at IS NULL
     AND (legacy_bounded_at IS NOT NULL
          OR expires_at IS NULL
          OR scopes IS NULL
          OR NOT (scopes LIKE ANY (ARRAY['%"read:feedback"%', '%"write:feedback"%',
            '%"write:changelog"%', '%"read:article"%', '%"write:article"%',
            '%"read:chat"%', '%"write:chat"%', '%"admin:workspace"%'])));
   ```

   For each key still in use (`last_used_at` is recent), the designated
   administrator creates a key with the scopes the integration needs and an
   expiry, moves the integration to it before `expires_at`, and revokes the
   old key. Revoke a key nobody uses at once. The list is empty when the
   cutover is done.

   A key made by the password bootstrap account acts as a Contributor once
   that account is demoted (step 3), so the team and administrator API refuses
   it whatever its scopes. Replace it with a key the designated administrator
   creates.

5. **Break-glass** stays the feedback operations repository's SSM path. If
   step 2 cannot pass (for example the provider reports the address as
   unverified), no one can administer through the app until it does; nothing
   in the app can create an administrator any other way.

## Never zero administrators

The onboarding bootstrap claim (`claimBootstrapAdmin` in
`lib/server/functions/onboarding.ts`, DEF-05) refuses every caller once any
human `admin` row exists. It counts stored rows, including one this rule marks
Inactive, so the password bootstrap row keeps the claim closed until step 3,
and step 3 is allowed only after step 2 produced a qualifying administrator.
Every role writer keeps at least one human administrator row, so the claim
stays closed.

That guard assumes at least one human administrator row always exists. Never
remove the last one outside the app (for example by SQL): with no human
`admin` row, the first account that satisfies the rule and calls the
onboarding functions becomes administrator.
