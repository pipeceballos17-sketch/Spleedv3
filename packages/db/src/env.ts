import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
})

export type DbEnv = z.infer<typeof envSchema>

let cached: DbEnv | null = null

export function loadEnv(): DbEnv {
  if (cached) return cached

  // SUPABASE_URL and SUPABASE_ANON_KEY may live under their NEXT_PUBLIC_ aliases
  // when .env.local is shared with the Next.js frontend. The anon key is meant
  // to be publicly exposed per Supabase's security model (RLS enforces boundaries).
  // Accept either name; the unprefixed canonical name wins if both are set.
  const merged = {
    ...process.env,
    SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY:
      process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }

  const parsed = envSchema.safeParse(merged)
  if (!parsed.success) {
    console.error('Invalid environment variables:')
    console.error(parsed.error.format())
    throw new Error('Failed to load DB environment — see errors above')
  }
  cached = parsed.data
  return cached
}
