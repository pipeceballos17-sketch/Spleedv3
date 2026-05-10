/**
 * Apply schema migrations + RLS + helpers + triggers + hooks + bootstrap to the
 * Postgres instance at DATABASE_URL.
 *
 * Order:
 *   1. drizzle migrations from /migrations (tables, columns, FKs, indexes, enums)
 *   2. src/rls/01-helpers.sql
 *   3. src/rls/02-triggers.sql
 *   4. src/rls/03-access-token-hook.sql
 *   5. src/rls/04-bootstrap.sql
 *   6. src/rls/05-policies.sql
 *
 * All raw SQL files are idempotent via CREATE OR REPLACE / DROP IF EXISTS.
 *
 * Usage: bun run db:migrate
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../env'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_ROOT = join(__dirname, '..', '..')

const RLS_FILES = [
  '01-helpers.sql',
  '02-triggers.sql',
  '03-access-token-hook.sql',
  '04-bootstrap.sql',
  '05-policies.sql',
]

async function main() {
  const env = loadEnv()
  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 })

  try {
    console.log('→ Applying drizzle migrations…')
    const db = drizzle(sql)
    await migrate(db, { migrationsFolder: join(PACKAGE_ROOT, 'migrations') })
    console.log('  ✓ tables/columns/indexes up to date')

    for (const file of RLS_FILES) {
      console.log(`→ Applying ${file}…`)
      const content = await readFile(join(PACKAGE_ROOT, 'src', 'rls', file), 'utf-8')
      await sql.unsafe(content)
      console.log(`  ✓ ${file}`)
    }

    console.log('\nMigration complete.')
  } catch (err) {
    console.error('Migration failed:', err)
    await sql.end()
    process.exit(1)
  }
  await sql.end()
}

main()
