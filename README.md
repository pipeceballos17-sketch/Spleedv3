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

(Setup instructions will be added in Sprint 0)
