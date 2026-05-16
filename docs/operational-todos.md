# Operational TODOs — Spleed pre-MVP

> External tasks that don't go in code commits but are required to ship the MVP. Tracked here so they don't slip between sprints. Update status as items resolve.

## Now (start in parallel — long lead time)

- [ ] **Stripe Issuing application** — apply as platform. Approval takes 2–6 weeks. Required by Sprint 8 (Gifter agent emits virtual cards via Stripe Issuing). Start: https://stripe.com/issuing → "Get started" → Platform application. The earlier this starts, the less it blocks Sprint 8.
- [ ] **5 secondary domains for email warmup** — register, set up DNS + SPF + DKIM + DMARC, start sending low-volume traffic to build sender reputation. Warmup takes ~2–4 weeks per domain. Required by Sprint 7 (Outreach Operator email channel). Domain examples: variations of the brand or generic-sounding aliases (avoid `spleed.ai` itself for cold outbound).

## Before Sprint 1

- [ ] **Supabase project** — create new project on Supabase, region close to Railway region (US-East likely). Capture: `DATABASE_URL` (pooled + direct), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Add to `.env.local`. Sprint 1 schema migrations land here.
- [ ] **Vercel project** — connect GitHub repo `pipeceballos17-sketch/Spleedv3`, root directory `apps/web`. First deploy will be the placeholder we just built — verify green and reachable at the auto-assigned `*.vercel.app` URL. Custom domain comes later when DNS is ready.
- [ ] **Railway project** — connect GitHub repo, root `apps/api`, start command `bun src/index.ts`, build command empty (Bun runs TS natively). First deploy = the Bun.serve placeholder — verify `https://<railway-url>/health` returns `{"ok":true,"service":"spleed-api"}`. Add Redis Upstash addon (free tier) — used by BullMQ starting Sprint 5.

## Future (for awareness, defer)

- Anthropic Claude Teams API key (Sprint 5 — workspace already exists per CLAUDE.md)
- Apify token already loaded with $80 (Sprint 5 — verify token in account settings when needed)
- Resend account (Sprint 7 — set up after domain warmup is well underway)
- Google Cloud Console + Gmail OAuth app (Sprint 7 — for founder Gmail OAuth)
- Cal.com decision: self-hosted vs cloud free tier (Sprint 6/7 — for booking links in microsites)
- Sendblue account, ~$100/mes/línea (Sprint 8 — defer until first paying design partner per CLAUDE.md)

### Sprint 6 prep — agent-browser de Vercel

- [ ] Sign up Vercel AgentCore (cuando lleguemos a Sprint 6)
- [ ] Decidir: local daemon vs AgentCore cloud al inicio
- [ ] Reserve $15/founder/mes en COGS planning
- [ ] Review agent-browser docs antes de Sprint 6 plan negotiation

## Already done (Sprint 0)

- [x] GitHub repo `pipeceballos17-sketch/Spleedv3` initialized
- [x] WSL Ubuntu dev env with Bun 1.3.13 at `/home/felipe/.bun/bin/bun`
- [x] Antigravity IDE with `CLAUDE.md` loaded
- [x] NOPASSWD `chown` for `/usr/bin/chown` configured (see `docs/adr/0001-plan9-ownership-and-nopasswd-chown.md`)
- [x] Monorepo scaffold pushed to `origin/main` (commits `f632dcf`, `c176a61`)

---

**Created:** 2026-05-10 (Sprint 0 close)
**Owner:** Felipe
**Status:** Not yet committed to git — review and commit when you want it tracked.
