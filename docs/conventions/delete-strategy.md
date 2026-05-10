# Convention: Delete Strategy

Hybrid by table, decided in Sprint 1 plan negotiation.

## Soft delete (`deleted_at` column)

Tables that retain user-visible history or participate in audit / analytics queries:

- `leads`
- `lead_dossiers`
- `gifts`
- `outreach_events`
- `concierge_threads`

Implementation: `deleted_at timestamptz` nullable column. Application queries filter `WHERE deleted_at IS NULL` by default. Add a partial index `(org_id, deleted_at) WHERE deleted_at IS NULL` so the active-row hot path stays fast even as soft-deleted rows accumulate.

Soft delete preserves referential context: an outreach event whose lead was "deleted" remains queryable for analytics (`how many emails did we send to deleted leads?`), and conversation threads stay readable.

## Hard delete

Tables where rows are append-only telemetry, short-lived state, or auth artifacts:

- `tracking_events` — raw analytics; aggregates persisted elsewhere
- `tool_call_logs` — debug telemetry; rotates after 90 days
- `daily_briefs` (Sprint 9) — magic-link tokens, expire 1h
- Magic link / refresh tokens (managed by Supabase Auth, not our schema)

Hard delete is direct `DELETE FROM`. No retention beyond the table's natural rotation.

## GDPR scrubbing

A separate background job lands in **Sprint 14+** to handle right-to-be-forgotten:

1. Receive request keyed by `users.email` or `leads.email`
2. Hard-delete all rows referencing that email across every table (overrides soft delete for this case)
3. Replace immutable references in `audit_logs.payload` (e.g., the email mentioned inside a JSONB blob) with `__redacted__`
4. Log the scrub operation itself in a dedicated `gdpr_scrub_log` table for compliance audit

This pattern keeps soft-delete useful for ops while still allowing real erasure when legally required.

## Sprint 1 status

Sprint 1 in-scope tables (`orgs`, `users`, `org_members`, `org_integrations`, `agent_templates`, `org_agents`, `audit_logs`) do **not** receive `deleted_at` columns — none of them require user-visible deletion history. Future tables that need soft delete add the column when their migration lands.

When implementing a new table, decide its delete strategy before writing the migration and document the choice in the schema file's leading comment block.
