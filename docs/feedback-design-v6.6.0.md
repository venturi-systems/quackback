# Feedback Design and Participation Update

This change applies Venturi design-system v6.6.0 to the maintained Quackback
fork and corrects misleading participation controls.

## Design Authority

The supplied canonical token CSS is copied unchanged into
`apps/web/src/styles/venturi-tokens.css`. The compatibility stylesheet maps
existing application variables to semantic roles. `venturi-dark.css` adapts the
canonical dark block to the class used by next-themes without changing values.
The public portal retains its explicit light register. DM Sans, Space Grotesk,
font licenses, and Venturi artwork are self-hosted from the supplied distribution.
Asset checksums are recorded in `venturi-assets-manifest.json`.

The portal shares a useful-width shell, visible page introduction, participation
explanation, and related-site footer. Card titles and board names can wrap.
Control borders use the control token, separately from decorative dividers.

## Behavior and Authorization

An authenticated portal user no longer receives administration links when no
boards are accessible. Team members can manage feedback; administrators can
configure boards. Unknown roles and signed-out sessions fail closed in the UI.
The server remains the authority for every action.

Existing database-backed role checks were reviewed in current and deployed
source. Status changes, moving posts, and roadmap changes require `admin` or
`member`; role changes and invitations require `admin`. Public signup creates
`user`. The design change itself does not alter those permissions; the
authorization fixes below close the paths that could.

## Authorization Fixes

These server-side fixes apply under both the private (sign-in) posture and a
future public-read posture:

- `listBoardsForOnboarding` lists every board, protected boards included, so it
  now answers only a human administrator. Every other caller receives an empty
  list. Its RPC id is unchanged, so an anonymous probe can assert zero boards.
- Onboarding (`saveUseCaseFn`, `setupWorkspaceFn`) grants `admin` only while
  no human administrator exists, never to an anonymous session, and never
  because `setup_state` is empty or partial. The claim runs in one transaction
  under the same advisory lock as the SSO bootstrap promotion.
- `checkOnboardingState` identifies the caller from the session, accepts no
  client-supplied user id, and never writes.
- A team role (`admin`, `member`) only counts on a human principal. Anonymous
  principals are treated as portal users in `requireAuth`, the optional-auth
  path, the admin shell guard, widget and MCP OAuth sessions, and image upload.
- `POST /api/auth/sign-in/anonymous` is refused unless the workspace allows
  anonymous participation.
- OAuth dynamic client registration requires a signed-in account unless the
  operator sets `OAUTH_ALLOW_UNAUTHENTICATED_CLIENT_REGISTRATION=true`.
  Anonymous sessions cannot register clients. API keys remain the supported
  identity for agents, and the admin MCP guide offers OAuth configs only when
  registration is open.
- The raw settings row (widget signing secret, portal allowlists) is no longer
  reachable through a public RPC, and bootstrap data is redacted before it
  leaves the server.
- Help-center reads, author avatars and identity lookups follow the portal
  gate. The widget document returns 404 while the widget is disabled.
- Inline widget email capture uses the identify route's unverified path. It no
  longer obtains a server-signed token for a typed address, which the route
  would have trusted as host-verified.

The create-post response now includes its persisted moderation state. A durable
confirmation explains when a submission awaits review and links to the author's
submission. Creation refreshes server-filtered feeds instead of inserting the
new post into every cached board and search result. Failed feed or roadmap
requests provide retry controls and do not display a false empty result.

## Source Publication and Deployment

These layout and behavior changes require application source changes and cannot
be expressed solely through workspace settings. They remain in the public
`venturi-systems/quackback` fork under its existing AGPL license. The footer links
to that source. Publish the exact reviewed commit through the existing CI and
image workflow, then update the immutable image/source pair in
`venturi-systems/feedback`. Preserve the fork's reviewed upstream intake process.

Production was still private during the audit. All nine live boards required
sign-in, despite a reviewed public-read policy already existing in the
infrastructure repository. The active SSM document was version 13 and did not
install the current policy. Application deployment alone does not reopen the
portal. Follow `feedback/docs/design-rollout-readiness.md` to install the reviewed
allowlist and check anonymous, contributor, team-member, and administrator paths.
Do not infer public visibility from HTTP 200 on a sign-in page.

## Verification Scope

Focused checks passed: 31 UI/permission tests; 21 submission-cache, anonymous
permission, and empty-state tests; and an independent 271-test authorization
review. These groups overlap and must not be added into a unique total.
The production build passed after the required widget build. Full lint passed
with existing warnings, and the full typecheck passed. These checks ran locally
against the application source published on the review branch.

The required `bun run test --run` command could not execute its suite because
PostgreSQL was unavailable locally. A separate all-suite Vitest attempt found
existing migration tests requiring that database and was stopped. This is not
a full-suite pass. Run the existing CI workflow with its PostgreSQL service
before proposing a pull request, as required by AGENTS.md. The available Actions
dispatch credential returned HTTP 403, so that CI run has not started. Normal
local user-namespace isolation for PostgreSQL also failed with `Operation not
permitted`; neither restriction was bypassed.

The authorization fixes were verified later with the full suite against a
disposable PostgreSQL service and a local production build. The pull request
records the exact commands and results.

Synthetic fixtures use the actual new React components and production CSS at
320, 390, 768, 1024, 1440, 1920, and 2560 pixels. Static role-link checks passed.
Browser policy blocked local-file navigation; no rendered screenshot, loaded
font, line-ending, overflow, zoom, or full workflow pass is claimed. Those
checks and authenticated live behavior remain release acceptance requirements.
