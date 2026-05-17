import { startAllWorkers, type RunningWorkers } from '@spleed/agents/workers'

const REQUIRED_ENV = ['REDIS_URL', 'ANTHROPIC_API_KEY', 'DATABASE_URL'] as const

/**
 * Validate required env vars and start every registered worker. Called from
 * `apps/api/src/index.ts` on boot. Throws loudly if any required var is missing
 * so failure is visible at startup rather than silently 5 minutes later when
 * the first job arrives.
 */
export function startWorkers(): RunningWorkers {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(
      `Cannot start workers: missing required env vars: ${missing.join(', ')}. ` +
        'Check .env.local against .env.example.',
    )
  }
  return startAllWorkers()
}
