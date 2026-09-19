# Venturi Agent Instructions: quackback

Customer feedback platform. Bun monorepo, TanStack Start, PostgreSQL + Drizzle, Tailwind v4 + shadcn/ui.

## Boundaries

| Tier | Semantics | Examples |
|------|-----------|---------|
| Always | Execute without confirmation | Run bun tests, lint, typecheck, format code, generate migrations |
| Ask First | Request human approval first | Schema breaking changes, tier limit policy modifications |
| Never | Do not attempt under any circumstances | Commit secrets or passwords, bypass typecheck/lint gates, reference forbidden identities |

## Non-Negotiables

- **Entity ID Structure**: Entity IDs are branded TypeIDs via `@quackback/ids`.
- **No Co-Author Trailers**: Never add co-author trailers to git commits.
- **Strict Verification**: `bun run test`, `bun run lint`, and `bun run typecheck` must pass before proposing pull requests.

## Verification Commands

| Changed Surface | Command |
|----------------|------------|
| Full Validation | `bun run test && bun run lint && bun run typecheck` |
| Build | `bun run build` |
| DB Migrations | `bun run db:generate` |

## Multi-Agent Roles

| Role | Scope | Gate |
|------|-------|------|
| planner | all (read-only) | plan full-stack features |
| frontend-engineer | apps/web/, packages/ui/ | `bun run lint && bun run typecheck` |
| backend-engineer | apps/web/src/lib/server/, packages/db/ | `bun run test` |
| release-manager | .github/, deploy/ | CI validation + PR auto-merge |
