import { eq } from 'drizzle-orm'
import { getServiceClient, orgs as orgsTable } from '@spleed/db'
import { createQueue } from './queue'
import type { ScoutJob } from './scout.worker'

/**
 * Default cron pattern: every day at 6 AM in the tenant's timezone.
 *
 * Sprint 5b ships a single hardcoded pattern; per-tenant customization
 * (multiple ICPs on different cadences) lands with the dashboard cron UI
 * in Sprint 9-10.
 */
const DEFAULT_SCOUT_CRON_PATTERN = '0 6 * * *'

/**
 * BullMQ job-scheduler id is global per queue, so it must be unique across
 * tenants. Convention: `cron-<orgId>-<icpId>` — pure-hyphen format that
 * stays well clear of BullMQ's "0 or 2 colons" jobId rule (see Sprint 5a
 * postmortem in scout.worker.ts idempotencyKey comment).
 */
export function scoutCronSchedulerId(orgId: string, icpId: string): string {
  return `cron-${orgId}-${icpId}`
}

async function loadOrgTimezone(orgId: string): Promise<string> {
  const db = getServiceClient()
  const [org] = await db
    .select({ timezone: orgsTable.timezone })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
  if (!org) {
    throw new Error(`SCOUT_CRON_ORG_NOT_FOUND: org=${orgId}`)
  }
  return org.timezone
}

/**
 * Register a Scout cron job for an org+ICP. Daily at 6 AM org-local time.
 *
 * Idempotent: BullMQ's `upsertJobScheduler` updates an existing scheduler
 * with the same id rather than failing. Safe to call repeatedly after
 * config changes (e.g. tenant timezone update — re-call to refresh).
 *
 * Returns the BullMQ scheduler id for logging/dashboard surfacing.
 */
export async function registerScoutCronForOrg(
  orgId: string,
  icpId: string,
  options?: { pattern?: string; requestedVolume?: number },
): Promise<string> {
  const tz = await loadOrgTimezone(orgId)
  const pattern = options?.pattern ?? DEFAULT_SCOUT_CRON_PATTERN
  const requestedVolume = options?.requestedVolume ?? 50

  const schedulerId = scoutCronSchedulerId(orgId, icpId)
  const queue = createQueue<ScoutJob>('scout')
  try {
    // Payload deliberately omits runId — the worker creates the scout_runs
    // row on each firing so every cron tick gets a fresh row to track.
    await queue.upsertJobScheduler(
      schedulerId,
      { pattern, tz },
      {
        name: 'scout',
        data: {
          orgId,
          icpId,
          requestedVolume,
          triggerType: 'cron',
        },
      },
    )
  } finally {
    await queue.close()
  }
  return schedulerId
}

/**
 * Remove the cron schedule entirely. Use when an ICP is deleted or the
 * founder turns off automated scouting. To temporarily disable, use
 * `pauseScoutCron` instead (semantically identical today — BullMQ has no
 * native pause for individual schedulers — but the helper expresses
 * intent for future implementations).
 */
export async function unregisterScoutCronForOrg(
  orgId: string,
  icpId: string,
): Promise<boolean> {
  const schedulerId = scoutCronSchedulerId(orgId, icpId)
  const queue = createQueue<ScoutJob>('scout')
  try {
    return await queue.removeJobScheduler(schedulerId)
  } finally {
    await queue.close()
  }
}

/**
 * Pause an active cron. Sprint 5b: aliases unregister — BullMQ has no
 * per-scheduler pause primitive (queue-wide pause exists but would affect
 * other tenants in the same queue). Sprint 9 may introduce a `cron_paused`
 * column on icps to suppress firings without losing the schedule, but for
 * now pause+resume = unregister+register (idempotent, no state loss).
 */
export async function pauseScoutCron(
  orgId: string,
  icpId: string,
): Promise<boolean> {
  return unregisterScoutCronForOrg(orgId, icpId)
}

export async function resumeScoutCron(
  orgId: string,
  icpId: string,
  options?: { pattern?: string; requestedVolume?: number },
): Promise<string> {
  return registerScoutCronForOrg(orgId, icpId, options)
}

/**
 * Read the active cron config for diagnostics / dashboard.
 * Returns null if no scheduler registered for this org+icp.
 */
export async function getScoutCron(
  orgId: string,
  icpId: string,
): Promise<{ id: string; pattern: string | null; tz: string | null; nextFireAt: Date | null } | null> {
  const schedulerId = scoutCronSchedulerId(orgId, icpId)
  const queue = createQueue<ScoutJob>('scout')
  try {
    const scheduler = await queue.getJobScheduler(schedulerId)
    if (!scheduler) return null
    return {
      id: schedulerId,
      pattern: scheduler.pattern ?? null,
      tz: scheduler.tz ?? null,
      nextFireAt: scheduler.next ? new Date(scheduler.next) : null,
    }
  } finally {
    await queue.close()
  }
}
