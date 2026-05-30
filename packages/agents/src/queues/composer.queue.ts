/**
 * Composer queue enqueue seam (Sprint 8.2).
 *
 * The 'composer' BullMQ queue is provisioned by defineWorker (same pattern as
 * scout/profiler/concierge). This is the public enqueue helper called by the
 * Slack interaction handler (🔄 Regenerate) and future dashboard/API triggers.
 */

import { composerWorker, type ComposerJob } from '../workers/composer.worker'

export async function enqueueComposerJob(job: ComposerJob): Promise<void> {
  await composerWorker.enqueue(job)
}
