/**
 * Outreach Operator queue enqueue seam (Sprint 8.2).
 *
 * The 'outreach-operator' BullMQ queue is provisioned by defineWorker (same
 * pattern as scout/profiler/concierge/composer). This is the public enqueue
 * helper called by the Slack interaction handler (✅ Approve & Send).
 */

import {
  outreachOperatorWorker,
  type OutreachDeliveryJob,
} from '../workers/outreach-operator.worker'

export async function enqueueOutreachDelivery(job: OutreachDeliveryJob): Promise<void> {
  await outreachOperatorWorker.enqueue(job)
}
