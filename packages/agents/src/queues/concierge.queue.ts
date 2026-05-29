/**
 * Concierge queue enqueue seam (Sprint 7c).
 *
 * The 'concierge' BullMQ queue itself is provisioned by defineWorker (same
 * pattern as scout/profiler — createQueue is internal to defineWorker). This
 * module is the public enqueue helper the API's Slack event handler calls;
 * it delegates to conciergeWorker.enqueue so payload validation + the
 * `concierge-{orgId}-{ts}` idempotency key (Slack delivers events at least
 * once) run in one place.
 */

import { conciergeWorker, type ConciergeJob } from '../workers/concierge.worker'

export async function enqueueConciergeJob(job: ConciergeJob): Promise<void> {
  await conciergeWorker.enqueue(job)
}
