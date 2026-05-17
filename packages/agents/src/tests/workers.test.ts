import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { sql, eq, desc } from 'drizzle-orm'
import {
  auditLogs,
  closeServiceClient,
  getServiceClient,
  orgMembers,
  orgs,
  users,
} from '@spleed/db'
import { closeRedisConnection, createQueue, helloWorldWorker } from '../workers'

const TEST_ORG_ID = '88888888-8888-8888-8888-888888888111'
const TEST_USER_ID = '88888888-8888-8888-8888-888888888222'
const TEST_USER_AUTH_ID = '88888888-8888-8888-8888-888888888333'

const HAS_REDIS = Boolean(process.env.REDIS_URL)
const suite = HAS_REDIS ? describe : describe.skip

async function seedTestOrg(): Promise<void> {
  const db = getServiceClient()
  await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
  await db.insert(orgs).values({ id: TEST_ORG_ID, name: 'Worker Test Org', slug: 'worker-test-org' })
  await db.insert(users).values({
    id: TEST_USER_ID,
    supabaseAuthId: TEST_USER_AUTH_ID,
    email: 'worker@test.spleed.ai',
    name: 'Worker Test',
  })
  await db.insert(orgMembers).values({ orgId: TEST_ORG_ID, userId: TEST_USER_ID, role: 'owner' })
}

/**
 * Wipe every job from the hello-world BullMQ queue (waiting, active, delayed,
 * completed, failed). Required for test isolation: without it, retry-backoff
 * jobs from one test leak into the next test's worker (see project memory
 * `feedback_bullmq_test_isolation.md` for the post-mortem).
 */
async function cleanQueue(): Promise<void> {
  const queue = createQueue('hello-world')
  await queue.obliterate({ force: true })
  await queue.close()
}

async function cleanAuditLogs(orgId: string): Promise<void> {
  const db = getServiceClient()
  await db.delete(auditLogs).where(eq(auditLogs.orgId, orgId))
}

async function waitForAuditLog(
  orgId: string,
  action: string,
  timeoutMs = 10_000,
): Promise<typeof auditLogs.$inferSelect | undefined> {
  const db = getServiceClient()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.orgId, orgId))
      .orderBy(desc(auditLogs.createdAt))
    const match = rows.find((r) => r.action === action)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return undefined
}

suite('hello-world worker (requires REDIS_URL)', () => {
  beforeAll(async () => {
    await seedTestOrg()
    await cleanQueue() // clear leftover jobs from any prior test run
  })

  afterEach(async () => {
    // Isolate consecutive tests: nuke the BullMQ queue + per-org audit logs.
    // Without this, transient-error jobs in retry backoff bleed into the
    // next test's worker and corrupt audit_log assertions.
    await cleanQueue()
    await cleanAuditLogs(TEST_ORG_ID)
  })

  afterAll(async () => {
    const db = getServiceClient()
    await db.execute(sql`TRUNCATE TABLE public.orgs, public.users RESTART IDENTITY CASCADE`)
    await closeRedisConnection()
    await closeServiceClient()
  })

  it('processes a job end-to-end and writes start + complete audit logs', async () => {
    const bullWorker = helloWorldWorker.start()
    try {
      await helloWorldWorker.enqueue({
        orgId: TEST_ORG_ID,
        // Date.now() in message ensures jobId is unique per run — safety belt
        // against idempotency dedup if cleanQueue() ever misfires.
        message: `integration test ${Date.now()}`,
      })

      const start = await waitForAuditLog(TEST_ORG_ID, 'worker.hello-world.start')
      const complete = await waitForAuditLog(TEST_ORG_ID, 'worker.hello-world.complete')
      const processed = await waitForAuditLog(TEST_ORG_ID, 'hello_world.processed')

      expect(start).toBeDefined()
      expect(complete).toBeDefined()
      expect(processed).toBeDefined()
    } finally {
      await bullWorker.close()
    }
  }, 30_000)

  it('transient error retries (audit shows attempt > 1 then complete or final failed)', async () => {
    const bullWorker = helloWorldWorker.start()
    try {
      await helloWorldWorker.enqueue({
        orgId: TEST_ORG_ID,
        message: `transient-${Date.now()}`,
        simulateError: 'transient',
      })

      // We expect at least 2 failed entries (initial + retry). Wait for the second failure.
      const db = getServiceClient()
      const deadline = Date.now() + 60_000
      let attempts = 0
      while (Date.now() < deadline) {
        const failures = await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.orgId, TEST_ORG_ID))
        attempts = failures.filter((r) => r.action === 'worker.hello-world.failed').length
        if (attempts >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(attempts).toBeGreaterThanOrEqual(2)
    } finally {
      await bullWorker.close()
    }
  }, 90_000)

  it('permanent error goes to DLQ on first attempt (UnrecoverableError)', async () => {
    const bullWorker = helloWorldWorker.start()
    try {
      await helloWorldWorker.enqueue({
        orgId: TEST_ORG_ID,
        message: `permanent-${Date.now()}`,
        simulateError: 'permanent',
      })

      const failed = await waitForAuditLog(TEST_ORG_ID, 'worker.hello-world.failed', 15_000)
      expect(failed).toBeDefined()
      const payload = failed?.payload as Record<string, unknown> | null | undefined
      expect(payload?.classification).toBe('dlq')
    } finally {
      await bullWorker.close()
    }
  }, 30_000)
})
