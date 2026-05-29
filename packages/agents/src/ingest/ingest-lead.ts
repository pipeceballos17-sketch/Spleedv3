/**
 * Shared lead-ingest core (Sprint 7c CP3).
 *
 * Extracted from apps/api POST /api/leads/ingest (Sprint 7a) so BOTH the HTTP
 * handler and the concierge worker run the SAME normalize → resolve-ICP →
 * dedupe → insert/upsert → enqueue-Profiler logic. The handler maps the
 * discriminated result to HTTP status codes; the worker maps it to Slack
 * replies. No duplicated dedupe/ICP-resolution logic across the two callers.
 *
 * This module owns DB writes + Profiler enqueue. The optional synchronous
 * "wait for Profiler" step stays with each caller (they use different
 * timeouts and surface the result differently), via the relocated
 * waitForJob helper (../workers/wait-for-job).
 */

import { and, eq, sql } from 'drizzle-orm'
import {
  getServiceClient,
  icps as icpsTable,
  leads as leadsTable,
  type DbClient,
} from '@spleed/db'
import { normalizeCompanyDomain, normalizeLinkedinUrl } from '@spleed/shared/normalize'
import { profilerWorker } from '../workers/profiler.worker'

export interface IngestLeadInput {
  orgId: string
  /** Raw values — ingestLead normalizes linkedinUrl/companyDomain internally. */
  linkedinUrl?: string | null
  companyDomain?: string | null
  name?: string | null
  title?: string | null
  notes?: string | null
  /** Explicit ICP. When omitted, falls back to the org's default ICP. */
  icpId?: string | null
  /** Provenance tag persisted to leads.ingest_source. */
  ingestSource: 'manual_url' | 'slack_concierge'
}

export type IngestLeadResult =
  | { outcome: 'invalid_payload' }
  | { outcome: 'icp_not_in_org'; requestedIcpId: string }
  | {
      outcome: 'inserted'
      leadId: string
      icpId: string | null
      profilerEnqueued: boolean
      profilerJobId: string | null
    }
  | {
      outcome: 'existing'
      leadId: string
      mode: 'cached' | 're_enriching'
      profilerEnqueued: boolean
      profilerJobId: string | null
      manualIngestCount: number
    }

/**
 * Resolve which ICP a new lead should be associated with. Explicit icpId
 * wins (verify ownership); otherwise the org's default ICP; otherwise null
 * (lead parked, Profiler skip-if-no-icpId path activates).
 */
async function resolveIcpId(
  db: DbClient,
  orgId: string,
  requestedIcpId: string | null | undefined,
): Promise<{ icpId: string | null } | { error: 'icp_not_in_org' }> {
  if (requestedIcpId) {
    const rows = await db
      .select({ id: icpsTable.id })
      .from(icpsTable)
      .where(and(eq(icpsTable.id, requestedIcpId), eq(icpsTable.orgId, orgId)))
    if (rows.length === 0) return { error: 'icp_not_in_org' }
    return { icpId: requestedIcpId }
  }
  const rows = await db
    .select({ id: icpsTable.id })
    .from(icpsTable)
    .where(and(eq(icpsTable.orgId, orgId), eq(icpsTable.isDefault, true)))
  return { icpId: rows[0]?.id ?? null }
}

/**
 * Soft dedupe lookup. LinkedIn URL is the strongest match (1:1 person);
 * (companyDomain + name) is the URL-less fallback. companyDomain alone is
 * intentionally NOT a match key — every company has many leads.
 */
async function findExistingLead(
  db: DbClient,
  orgId: string,
  match: { linkedinUrl: string | null; companyDomain: string | null; name: string | null },
): Promise<typeof leadsTable.$inferSelect | null> {
  if (match.linkedinUrl) {
    const rows = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.orgId, orgId), eq(leadsTable.linkedinUrl, match.linkedinUrl)))
      .limit(1)
    if (rows[0]) return rows[0]
  }
  if (match.companyDomain && match.name) {
    const rows = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.orgId, orgId),
          eq(leadsTable.companyDomain, match.companyDomain),
          sql`lower(${leadsTable.fullName}) = lower(${match.name})`,
        ),
      )
      .limit(1)
    if (rows[0]) return rows[0]
  }
  return null
}

/**
 * Re-trigger Profiler only when the lead is in a fresh-discovered state
 * (Sprint 6b reverts to 'discovered' after all-source-fail, so this also
 * covers "failed previously, re-try now").
 */
function shouldRetriggerProfiler(
  currentStatus: typeof leadsTable.$inferSelect['status'],
): boolean {
  return currentStatus === 'discovered'
}

export async function ingestLead(input: IngestLeadInput): Promise<IngestLeadResult> {
  const db = getServiceClient()

  // Normalize. A non-LinkedIn URL passed via linkedinUrl normalizes to null
  // (caller falls back to companyDomain or the payload is rejected below).
  const linkedinUrl = input.linkedinUrl ? normalizeLinkedinUrl(input.linkedinUrl) : null
  const companyDomain = input.companyDomain ? normalizeCompanyDomain(input.companyDomain) : null
  const name = input.name ?? null
  const title = input.title ?? null
  const notes = input.notes ?? null

  if (!linkedinUrl && !companyDomain && !name) {
    return { outcome: 'invalid_payload' }
  }

  const icpResolution = await resolveIcpId(db, input.orgId, input.icpId)
  if ('error' in icpResolution) {
    return { outcome: 'icp_not_in_org', requestedIcpId: input.icpId! }
  }
  const icpId = icpResolution.icpId

  const existing = await findExistingLead(db, input.orgId, { linkedinUrl, companyDomain, name })
  const nowIso = new Date().toISOString()

  if (existing) {
    // ─── UPSERT path — increment counter, append notes, conditional re-trigger
    const existingRaw = (existing.rawSignals as Record<string, unknown>) ?? {}
    const existingNotes =
      (existingRaw.manualIngestNotes as Array<{ at: string; text: string }>) ?? []
    const newRawSignals = notes
      ? { ...existingRaw, manualIngestNotes: [...existingNotes, { at: nowIso, text: notes }] }
      : existingRaw

    await db
      .update(leadsTable)
      .set({
        manualIngestCount: existing.manualIngestCount + 1,
        lastManualIngestAt: new Date(),
        ingestSource: existing.ingestSource ?? input.ingestSource,
        rawSignals: newRawSignals,
        updatedAt: new Date(),
      })
      .where(eq(leadsTable.id, existing.id))

    const retrigger = shouldRetriggerProfiler(existing.status) && existing.icpId !== null
    if (retrigger) {
      await profilerWorker.enqueue({
        leadId: existing.id,
        orgId: input.orgId,
        triggerType: 'manual_reingest',
      })
    }

    return {
      outcome: 'existing',
      leadId: existing.id,
      mode: retrigger ? 're_enriching' : 'cached',
      profilerEnqueued: retrigger,
      profilerJobId: retrigger ? `profiler-${existing.id}` : null,
      manualIngestCount: existing.manualIngestCount + 1,
    }
  }

  // ─── INSERT path — new lead
  const initialRawSignals: Record<string, unknown> = notes
    ? { manualIngestNotes: [{ at: nowIso, text: notes }] }
    : {}

  const [inserted] = await db
    .insert(leadsTable)
    .values({
      orgId: input.orgId,
      icpId,
      status: 'discovered',
      fullName: name,
      firstName: null,
      lastName: null,
      company: null,
      role: title,
      companyDomain,
      linkedinUrl,
      foundVia: 'manual_ingest',
      ingestSource: input.ingestSource,
      manualIngestCount: 1,
      lastManualIngestAt: new Date(),
      rawSignals: initialRawSignals,
    })
    .returning({ id: leadsTable.id })

  if (!inserted) {
    // Insert returning empty is an infra failure — surface as throw so the
    // caller's try/catch maps it to 500 (handler) / retry (worker).
    throw new Error('INGEST_INSERT_FAILED: leads insert returned no row')
  }
  const leadId = inserted.id

  // Enqueue Profiler only when an ICP is associated (worker would skip
  // otherwise — saves a no-op round-trip).
  if (!icpId) {
    return {
      outcome: 'inserted',
      leadId,
      icpId: null,
      profilerEnqueued: false,
      profilerJobId: null,
    }
  }

  await profilerWorker.enqueue({
    leadId,
    orgId: input.orgId,
    triggerType: 'manual',
  })

  return {
    outcome: 'inserted',
    leadId,
    icpId,
    profilerEnqueued: true,
    profilerJobId: `profiler-${leadId}`,
  }
}
