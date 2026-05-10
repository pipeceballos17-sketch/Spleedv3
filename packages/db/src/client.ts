import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { loadEnv } from './env'

export type DbClient = ReturnType<typeof drizzle<typeof schema>>
export { schema }

let _serviceSql: postgres.Sql | null = null
let _serviceClient: DbClient | null = null

/**
 * Service-role DB client. Bypasses RLS.
 *
 * Use only in:
 *   - Background workers (BullMQ jobs on Railway)
 *   - Webhook handlers (Sendblue, Stripe, Apify, Cal.com)
 *   - Public microsite renderer (reads asset by exact slug, never list)
 *   - Migrations, seeds, isolation test setup
 *
 * Service role bypasses RLS at the Postgres level. The defense-in-depth contract
 * is at the application layer: workers MUST receive org_id in their job payload
 * and filter every org-scoped query by it explicitly.
 */
export function getServiceClient(): DbClient {
  if (_serviceClient) return _serviceClient
  const env = loadEnv()
  _serviceSql = postgres(env.DATABASE_URL, { prepare: false, max: 10 })
  _serviceClient = drizzle(_serviceSql, { schema })
  return _serviceClient
}

/**
 * Close the underlying connection pool. Call from migration scripts and tests
 * on exit so the process can terminate cleanly.
 */
export async function closeServiceClient(): Promise<void> {
  if (_serviceSql) {
    await _serviceSql.end()
    _serviceSql = null
    _serviceClient = null
  }
}
