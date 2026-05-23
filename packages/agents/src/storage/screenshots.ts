/**
 * Profiler screenshot storage (Sprint 6b).
 *
 * Mock-default helper that synthesizes deterministic Supabase Storage
 * URLs for hook-evidence screenshots. Mirrors the Apollo / Anthropic /
 * Vercel / Apify mock-first pattern: tests never hit real Storage and
 * live mode throws loud until Sprint 7+ when concierge customers come
 * online and the prerequisite migration lands (BACKLOG-042: bucket
 * 'evidence' creation + RLS policies on storage.objects scoped to org
 * via path prefix).
 *
 * Storage path convention (mock + future live):
 *   evidence/{orgId}/{leadId}/{hookId}-{sourceType}.png
 *
 * That layout makes RLS straightforward — the live storage.objects
 * SELECT/INSERT policy in Sprint 7+ will check `name LIKE :orgId || '/%'`
 * with auth.uid() looking up org_members membership.
 */

import type { ProfilerSourceName } from '@spleed/integrations/anthropic'

const MOCK_STORAGE_BASE = 'https://mock-storage.spleed.ai'

export interface UploadScreenshotInput {
  hookId: string
  imageBytes: Buffer
  mimeType: string
}

export interface UploadedScreenshot {
  hookId: string
  url: string
  /** ISO timestamp of upload. */
  capturedAt: string
  sourceType: ProfilerSourceName
}

export interface UploadScreenshotsToStorageInput {
  screenshots: UploadScreenshotInput[]
  orgId: string
  leadId: string
  sourceType: ProfilerSourceName
  /**
   * Force mock mode. Defaults to `process.env.STORAGE_LIVE !== 'true'`.
   * Set STORAGE_LIVE=true to exercise the (currently throwing) live path
   * — Sprint 7+ wires real Supabase Storage once BACKLOG-042's bucket
   * migration lands.
   */
  mockMode?: boolean
}

function isMockByDefault(): boolean {
  return process.env.STORAGE_LIVE !== 'true'
}

/**
 * Upload screenshot bytes to (mock or real) Supabase Storage and return
 * descriptors suitable for the lead_dossiers.evidence_urls jsonb column.
 *
 * Idempotent in mock mode: same (orgId, leadId, hookId, sourceType)
 * inputs produce the same URL on every call. Useful for tests that
 * re-trigger Profiler to assert dossier state.
 */
export async function uploadScreenshotsToStorage(
  input: UploadScreenshotsToStorageInput,
): Promise<UploadedScreenshot[]> {
  const mockMode = input.mockMode ?? isMockByDefault()

  if (mockMode && process.env.NODE_ENV !== 'test') {
    console.log(
      '[storage] MOCK MODE ACTIVE — set STORAGE_LIVE=true to use real Supabase Storage',
    )
  }

  if (!mockMode) {
    return uploadScreenshotsLive(input)
  }

  return uploadScreenshotsMock(input)
}

function uploadScreenshotsMock(
  input: UploadScreenshotsToStorageInput,
): UploadedScreenshot[] {
  // Single timestamp for the whole batch — all screenshots taken inside
  // one extraction session share a capture moment.
  const capturedAt = new Date().toISOString()
  return input.screenshots.map((s) => ({
    hookId: s.hookId,
    url: `${MOCK_STORAGE_BASE}/evidence/${input.orgId}/${input.leadId}/${s.hookId}-${input.sourceType}.png`,
    capturedAt,
    sourceType: input.sourceType,
  }))
}

async function uploadScreenshotsLive(
  _input: UploadScreenshotsToStorageInput,
): Promise<UploadedScreenshot[]> {
  // Sprint 7+: wire to supabase.storage.from('evidence').upload(...) once
  // BACKLOG-042's migration creates the bucket + RLS policies. Policy:
  //   storage.objects SELECT/INSERT WHERE name LIKE auth.jwt() ->>
  //   'org_id' || '/%'.
  throw new Error(
    "[storage] live mode not implemented in Sprint 6b — wire real Supabase Storage in Sprint 7+ when concierge customers come online. Prerequisite: BACKLOG-042 migration creating bucket 'evidence' (private) + RLS policies on storage.objects org-scoped via path prefix {orgId}/...",
  )
}

export { MOCK_STORAGE_BASE }
