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
2. whose provider reported its email address as verified, and
3. whose address is at a domain in `VENTURI_TEAM_EMAIL_DOMAINS` (default
   `venturi.systems`; exact hostnames, subdomains never match).

The server checks the rule when a role is assigned **and** on every team or
administrator action (`lib/server/domains/principals/team-identity.ts`,
`session-role.ts`). A stored team role on an account that fails the rule acts
as a Contributor; Admin > Team marks it "Inactive" with the reason.

API keys follow the same rule: a key acts with the lower of its stored role
and its creator's current role, so a key made by an account that no longer
qualifies loses its team authority. No API key and no MCP client can change a
post's status.

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

Every role write runs in one transaction under one advisory lock
(`team-designation.ts`):

- a promotion needs a qualifying identity;
- taking `admin` away needs another administrator who satisfies the rule, so
  no path leaves the workspace without an administrator who can act;
- nobody changes or removes their own role;
- unlinking the last Google or GitHub account of the only such administrator
  is refused.

## Cutover after deploy (feedback.venturi.systems)

The feedback infrastructure repository delivers `VENTURI_TEAM_ADMIN_EMAILS`
and `VENTURI_TEAM_EMAIL_DOMAINS` (venturi-systems/feedback#209). Its release
runbook (`docs/design-rollout-readiness.md#release-runbook`) owns the order;
the fork-side steps are:

1. **Read the roles** (read-only SQL, runbook step 8): the password bootstrap
   administrator is `admin` with an unverified address and no Google or GitHub
   link, so under this release it already acts as a Contributor.
2. **Promote** (runbook step 9): the designated owner signs in with Google or
   GitHub. The sign-in hook promotes the account to `admin`; an already open
   session is promoted on its next request. Pass: the account is `admin` with
   `google` or `github` among its providers, Admin > Team shows it active.
3. **Demote the bootstrap account** (runbook step 10): in Admin > Team, the
   owner removes the bootstrap account's team role. The server allows it
   because another qualifying administrator exists.
4. **Break-glass** stays the feedback operations repository's SSM path. If
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
