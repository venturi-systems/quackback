# Signed-in render check

The CI job `Signed-in render check` (`.github/workflows/ci.yml`, job `signed_in_render`) renders the built portal as seeded fixture identities and measures it with two checks:

1. **Typography.** The Venturi design suite v6.6.0 text-quality checker, unmodified, on every route at every width in the suite's policy (`viewports.responsiveWidthsCssPx`), each as rendered and with the WCAG 1.4.12 text-spacing stress.
2. **Keyboard.** A Tab and Shift+Tab walk of every route on a 390px coarse-pointer phone and a 1440px fine-pointer desktop. It checks for visible focus, document order and focus traps. It also checks target size: 44px (`--ds-component-touch-minimum`) on a coarse pointer and 24px (WCAG 2.5.8) on a fine pointer. A focus indicator counts when it is on the element, beside it, or on the frame that tightly encloses it (up to six ancestors out, at most four times the element's area), as the composer card and the team comment form draw theirs.

It runs on pull requests that touch `apps/web` or `ci.yml`, and on `workflow_dispatch`. It is not part of the required `portability-gate`.

## Identities and routes

`plan.ts` lists every route, the identity that renders it, and the surfaces it must show. Those surfaces are the ones quackback #131 changed. A route fails when one of its surfaces is missing, so the check cannot silently measure a page that no longer has them. A surface the layout hides below a width (the post sidebar, from 1024px) is probed only from that width.

The seed assigns roadmaps and comments at random, so `find-render-post.ts` picks the post the post routes render: a post on a public roadmap (so the sidebar's roadmap links render), with a visible root comment, on a board anyone can read and comment on. It prefers a post where the administrator has a root comment.

| Identity  | Session source                                                                       |
| --------- | ------------------------------------------------------------------------------------ |
| admin     | `demo@example.com`, signed in by the end-to-end suite's `e2e/global-setup.ts`        |
| member    | `render-member@example.com`, signed in by `loginViaMagicLink` with the `member` role |
| anonymous | no session                                                                           |

No real credentials are involved. Every session comes from a magic-link token that the test database issued.

## How the unmodified checker sees a signed-in page

The checker opens each URL in a fresh browser context with no cookies. `session-proxy.ts` is a loopback reverse proxy that adds one identity's session cookie to every request it forwards to the app. The checker opens the proxy's URL, so it renders the signed-in page without a byte of the checker changing. `design-suite/` holds the three checker files exactly as released. `suite-pin.json` records their sha256 values against the suite's own index. The job and `tests/ci-contract.test.ts` both refuse any other bytes.

## Reports

The job uploads `signed-in-render-reports`:

- `plan.json`: the resolved routes.
- `checker/<route>.json`: the checker's own reports. `index.json` lists each invocation.
- `keyboard/<route>__<context>.json`: every stop of each walk, with its findings.
- `summary.md`: the job summary.
- `server.log`: the app's log.

The job fails on any checker `FAIL`, or on any keyboard finding. A checker `NEEDS_REVIEW` does not fail the job. The summary lists each one: prose, user-generated text, the text-spacing stress run, font evidence or unmeasured text. Each needs its own reviewed resolution.

## Running it locally

Serve the production image (`apps/web/Dockerfile`) on `http://acme.localhost:3000` against a migrated and seeded database, as the job does. Then, from `apps/web`:

```sh
bun run test:render            # sign in, write the plan, walk the keyboard
bun e2e/render/run-checker.ts  # the suite checker through the session proxies
bun e2e/render/summarize.ts    # summary and verdict
```

Set `RENDER_OUT_DIR` to choose where the reports go. It defaults to `test-results/render`. On a Venturi sister device, do not run these commands: validation runs in cloud CI.
