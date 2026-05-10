# Spleed

AI co-founder for founder-led sales. Lives in your iMessage.

> Internal note: This is Spleed v3 (clean rewrite). 
> Previous versions archived. Architecture documented in CLAUDE.md.

## Status

In active development. Pre-MVP.

## Stack

- **Monorepo:** Bun + Turbo
- **Frontend:** Next.js 15, TypeScript, Tailwind v4, shadcn/ui
- **Backend:** Supabase (Auth + Postgres + RLS + Vault), Railway (workers + queues)
- **AI:** Claude Sonnet 4.6 + Haiku 4.5 (with prompt caching)
- **Integrations:** Apify (scraping MVP), Sendblue (iMessage), Stripe Issuing (gifting)

## Documentation

- `CLAUDE.md` — Master prompt + architecture overview (read first)
- `BACKLOG.md` — Deferred features for future sprints
- `docs/e2e-flow-spec.md` — End-to-end product flow
- `docs/v02-patch.md` — Concierge agent + iMessage HITL
- `docs/v03-patch.md` — Ethical signals principle + multi-iMessage
- `docs/agents/agent-prompts.md` — System prompts for all 6 agents
- `docs/db/schema-spec.md` — Drizzle ORM schema reference
- `docs/db/rls-spec.sql` — Row Level Security policies
- `docs/db/isolation-test-spec.md` — Multi-tenant isolation tests

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.2

### Install

```bash
bun install
```

### Develop

```bash
# All apps in parallel
bun run dev

# Single app
bun --filter @spleed/web run dev    # http://localhost:3000
bun --filter @spleed/api run dev    # http://localhost:3001
```

### Verify

```bash
bun run typecheck    # tsc --noEmit across all workspaces
bun run build        # turbo orchestrates next build + tsc
bun run format       # prettier --write .
```

### Workspace layout

- `apps/web` — Next.js 15 dashboard + public microsites
- `apps/api` — Bun.serve backend (workers, queues, agent runtime, webhooks)
- `packages/db` — Drizzle schema + migrations + RLS (Sprint 1+)
- `packages/agents` — 6 agents: Scout, Profiler, Composer, Outreach, Gifter, Concierge (Sprint 5+)
- `packages/shared` — types, zod schemas, tagged errors, logger
