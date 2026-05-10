import { sql } from 'drizzle-orm'
import { closeServiceClient, getServiceClient } from '../client'
import { agentTemplates } from '../schema'
import { seedAgentTemplates } from './agent-templates'

async function main() {
  const db = getServiceClient()

  // Idempotent: ON CONFLICT (kind, version) DO NOTHING.
  await db
    .insert(agentTemplates)
    .values(seedAgentTemplates)
    .onConflictDoNothing({ target: [agentTemplates.kind, agentTemplates.version] })

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentTemplates)
  const count = result[0]?.count ?? 0

  console.log(`agent_templates seed complete — ${count} rows total`)
  await closeServiceClient()
}

main().catch(async (err) => {
  console.error('seed failed:', err)
  await closeServiceClient()
  process.exit(1)
})
