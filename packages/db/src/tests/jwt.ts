import { SignJWT } from 'jose'

export interface TestJWTClaims {
  sub: string
  email?: string
  org_id?: string
  org_role?: 'owner' | 'member'
  role?: 'authenticated' | 'anon' | 'service_role'
}

const ENCODER = new TextEncoder()

/**
 * Mint a Supabase-compatible signed JWT for tests.
 * Signs with the SUPABASE_JWT_SECRET so local Supabase Auth accepts it.
 */
export async function createTestJWT(claims: TestJWTClaims, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  const payload: Record<string, unknown> = {
    aud: 'authenticated',
    role: claims.role ?? 'authenticated',
  }
  if (claims.email !== undefined) payload.email = claims.email
  if (claims.org_id !== undefined) payload.org_id = claims.org_id
  if (claims.org_role !== undefined) payload.org_role = claims.org_role

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60)
    .setIssuer('supabase')
    .sign(ENCODER.encode(secret))
}
