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

## Public Shell, Sign-in Page and Status Pages

Every public page (the portal, the sign-in page, password reset and recovery,
and the 404 and error pages) uses one frame: the Venturi header (lockup named
"Venturi home", product label, portal navigation) and the footer with the
Venturi signature, the website's legal row in its published order, and the
AGPL-3.0 section 13 source link to the exact built commit. Identity lives in
`lib/shared/venturi-identity.ts`, not in string comparisons on the workspace
name.

A portal that requires sign-in to read shows a left-aligned sign-in page, not a
centered card. It says what the portal is, who can read it (from the portal's
real posture), and who can do what: contributors read, post, vote and comment;
team members also review posts, set status, move roadmap items, merge
duplicates, publish the changelog, and create and rename boards;
administrators also delete boards and change access, sign-in, portal settings
and members. The `<h1>` still starts with "Sign in", and only the enabled
providers are offered, so the infrastructure live check keeps its markers.

A missing page, a missing post and a post the viewer may not read all answer
with the same 404 page, so a 404 never confirms that a post exists.

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

The full suite, lint, typecheck and production build passed locally, and CI
(`portability-gate` with eight end-to-end shards) passed on the merge of pull
request #126. Each pull request records its exact commands and counts.

Rendered checks use the design suite's typography checker at 320, 390, 768,
1024, 1440, 1920 and 2560 pixels, each with and without WCAG 1.4.12
text-spacing overrides, on a local production build seeded with fictional
`@example.com` data under the live posture (sign-in required to read,
Google and GitHub only, anonymous sessions refused). Pages: the sign-in page,
the 404 and missing-post pages, recovery; as a contributor the feed, the
composer with its review notice open, the roadmap, the changelog, a post and
account settings; as a team member the feed, a post, the administrators-only
notice and the statuses page. The sign-in page for a private portal, the
no-access page and the anonymous feed and post under a public posture were
checked the same way.

Result: no authored headline or short-copy failure at any width. The sign-in
page passes with no review items. Remaining review items are user-generated
text (post titles, bodies, comments, changelog entries, marked
`data-text-origin="user"`) and authored labels that wrap only under the
text-spacing overrides, where reflow takes precedence. The 404 pages render
every text element cleanly; the checker also records their HTTP 404 status,
which is the intended answer. The infrastructure repository's release probes
(`validate_gate_explainer`, the gated-surface contract and the board
enumeration probe) pass against the local sign-in page and RPC.

After you choose a sign-in method, the sign-in page's explanation gives way to
a shorter lead. That happens at the email step and the two-factor steps.
Signing in, the lead reads "This portal is private. Sign in or create an
account to continue." Signing up, it reads "This portal is private. Create an
account to continue." The local runs above measured only the page's first
step.

So the leads were measured separately. The same checker ran on the services
hub against the released build `8ed10c35`. The page was the live sign-in page
with its markup, stylesheet and fonts, but no scripts. Only the heading and
lead text were changed to those steps' wording. This change does not touch
that build's sign-in page styles.

The checker covered every width listed above, each with and without the
text-spacing overrides. Neither lead left a single word on its last line.

The checker raised one review item. From 320 to 325 pixels (an independent
1-pixel sweep), under the text-spacing overrides only, the sign-up heading
"Create your Venturi account" takes three lines
and ends on one word. Two settings leave it no room: the 32-pixel heading size
for phones and the 20-pixel page margin. The WCAG spacing overrides take
precedence, so the heading is left to wrap.

Interactive targets were measured at 390 pixels with touch and at 1280 with a
mouse: no portal control is below 44 pixels on touch or 24 pixels with a
mouse. The administration console outside the settings notice was not
converted to the v6.6 type scale and touch targets.
