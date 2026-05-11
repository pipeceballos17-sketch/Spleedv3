# ADR 0002 — Lead fit_score Computation Strategy

**Status:** Accepted (Sprint 2 decision; implementation lands Sprint 5)
**Date:** 2026-05-11
**Sprint:** 2 (decision recorded), Sprint 5 (Scout v0.1 implements)

## Context

Scout (agent, lands Sprint 5) discovers leads. Each lead carries a `fit_score` in `[0, 1]` representing how well the lead matches the founder's ICP. The score drives:

- **Kanban prioritization** — founder sees high-fit leads first
- **Enrichment threshold** — whether to spend Profiler tokens on this lead
- **Outreach gating** — Scout drops leads silently below `fit_score < 0.5`

Sprint 2 settles the *schema* for fit_score:

- `leads.fit_score real`  — final score
- `leads.fit_reasoning text` — 1 sentence why
- `leads.fit_score_computed_at timestamptz` — staleness detection

The *computation algorithm* deferred to Sprint 5 is what this ADR records.

## Decision

**Hybrid: SQL hard-rule pre-filter, then Haiku 4.5 nuanced scoring.** Two-pass:

### Pass 1 — SQL hard rules (binary, deterministic)

Given an Apollo search result and `icps.parsed_filters`, evaluate:

- title matches one of `titles[]` (case-insensitive `ILIKE %title%`)
- industry matches one of `industries[]`
- company size in `[companySizeMin, companySizeMax]`
- geo matches one of `geos[]`
- funding stage matches one of `fundingStages[]`

Each filter is 0 or 1. Sum → preliminary score ∈ `[0, 5]`, normalized to `[0, 1]`.

**Drop silently** if normalized SQL score `< 0.4`. These never reach Pass 2 or get persisted as leads.

### Pass 2 — Haiku 4.5 nuanced scoring

For each lead that passes Pass 1, send to Haiku with:

- Lead summary (Apollo data, ~200 tokens)
- ICP `definition_natural_language` (~150 tokens)
- Any recent signals from the search context (funding announcement, hiring spike, etc.)

Haiku returns:

- `fit_score ∈ [0, 1]` (final value persisted)
- `fit_reasoning: string` (1 sentence)

### Persist

`fit_score`, `fit_reasoning`, `fit_score_computed_at = now()` saved with the lead row.

### Cost & latency budget

- ~500 tokens in / ~50 tokens out per Pass 2 lead → ~$0.005 with Haiku 4.5
- Pass 1 cuts 200 Apollo results to ~50 worth scoring → ~$0.25 per Scout run
- Latency: ~2-3s for the LLM batch (Pass 2 runs in parallel up to batch limit)

## Alternatives Considered

### Pure SQL rules

**Rejected.** ICPs have fuzzy edges that don't reduce to filter columns ("technical founder shipping to other founders" — no column captures this). SQL alone misses ~30% of good fits based on early founder-feedback tests.

### Pure LLM scoring on every Apollo result

**Rejected.** Cost: $0.005 × 200 leads/run = $1/run. SQL pre-filter cuts that 4x to $0.25/run for equivalent end quality on the matches that count. The leads dropped at Pass 1 are ones where binary rules clearly say "no" — LLM scoring them wastes tokens to learn the same answer.

### Vector embeddings (cosine similarity ICP ↔ lead)

**Rejected for v0.1.** Requires pgvector extension setup, two embedding columns per lead, embedding cost (~$0.001/lead per pass), and re-embedding when ICP changes. Net cost similar to LLM scoring but **loses the natural-language reasoning** that the founder reads in the kanban. Revisit if Scout latency becomes a bottleneck post-PMF or if score quality plateaus.

### LLM scoring with Sonnet 4.6 instead of Haiku 4.5

**Rejected for v0.1.** Sonnet is 8-12x cost. Quality marginally better for `fit_score` (a coarse 0-1 metric) — the qualitative work where Sonnet shines belongs to Profiler (dossier construction), not Scout (lead scoring).

## Consequences

### Positive

- Cost-efficient: ~$0.25 per Scout run for a 200-lead Apollo universe
- Transparent: `fit_reasoning` exposes the WHY to the founder
- Adjustable: SQL drop threshold (0.4) and the Pass 2 model are both knobs
- Reusable: the same SQL rules pass can support BACKLOG-001 (ICP-type-specific filtering) in Sprint 6 without changing the Pass 2 LLM prompt structure

### Negative

- **Two-pass architecture** is more code than a single LLM pass
- **SQL hard-rule false negatives** if `parsed_filters` is sparse — when the founder hasn't filled `industries`, every lead passes Pass 1 and the LLM does all the work. Acceptable tradeoff: sparse filters mean the founder hasn't expressed strong constraints, so the LLM's broader judgment is what we want anyway.
- **Staleness**: when Profiler updates the dossier with richer signals (Sprint 6 patterns from BACKLOG-005), `fit_score` doesn't auto-recompute. `fit_score_computed_at < dossier.updated_at` is the staleness signal. Sprint 6+ adds a re-score worker or on-read recomputation. For Sprint 5 v0.1, scores are computed once at discovery and not refreshed.

## References

- agent-prompts.md §1 (Scout) — defines `fit_score` in the `output_format` JSON
- Schema: `packages/db/src/schema/leads.ts` — `leads.fit_score`, `fit_reasoning`, `fit_score_computed_at`
- BACKLOG-001 — ICP-type variability; may expand the Pass 1 SQL filter set per ICP type in Sprint 6
- Sprint 2 plan negotiation (this session) — decision (b)
