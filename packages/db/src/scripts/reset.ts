/**
 * DESTRUCTIVE: drops the entire public schema and re-applies migrations + seed.
 *
 * Safety: refuses to run unless DATABASE_URL host is localhost / 127.0.0.1 /
 * host.docker.internal. To reset hosted production, do it manually.
 *
 * Usage: bun run db:reset
 */

import postgres from 'postgres'
import { loadEnv } from '../env'

async function main() {
  const env = loadEnv()

  const url = new URL(env.DATABASE_URL)
  const host = url.hostname
  const localHosts = ['localhost', '127.0.0.1', 'host.docker.internal']
  if (!localHosts.includes(host)) {
    console.error(`db:reset refused: DATABASE_URL host is "${host}", not local.`)
    console.error('reset is dev-only. To reset a hosted DB, do it manually.')
    process.exit(1)
  }

  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })

  try {
    console.log(`→ Dropping public schema on ${host}:${url.port}…`)
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
      GRANT ALL ON SCHEMA public TO postgres, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
    `)
    console.log('  ✓ public schema reset')
  } finally {
    await sql.end()
  }

  console.log('→ Re-applying migrations…')
  const migrateProc = Bun.spawn(['bun', 'run', 'db:migrate'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await migrateProc.exited) !== 0) {
    console.error('reset: migrate failed')
    process.exit(1)
  }

  console.log('→ Re-seeding agent_templates…')
  const seedProc = Bun.spawn(['bun', 'run', 'db:seed'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await seedProc.exited) !== 0) {
    console.error('reset: seed failed')
    process.exit(1)
  }

  console.log('\nReset complete.')
}

main().catch((err) => {
  console.error('reset failed:', err)
  process.exit(1)
})
