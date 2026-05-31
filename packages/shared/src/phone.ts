/**
 * Phone normalization to E.164 (Sprint 9).
 *
 * Self-contained (no libphonenumber-js — CLAUDE.md rule 6: prefer own code
 * <50 lines over a ~150KB dependency for what is currently mock-curated
 * data). Sprint 11+ may swap in libphonenumber-js if real extraction reveals
 * region-inference / per-country-validity edge cases (BACKLOG-062).
 *
 * Rules:
 *   - Leading '+' → international: keep digits, valid when 8-15 long (E.164).
 *   - No '+', exactly 10 digits → assume US, prepend +1.
 *   - No '+', 11 digits starting with 1 → US with country code, prepend +.
 *   - Anything else → null (can't infer a country code safely).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const hasPlus = raw.trim().startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return null

  if (hasPlus) {
    // E.164 allows up to 15 digits; require at least 8 to reject junk.
    if (digits.length < 8 || digits.length > 15) return null
    return `+${digits}`
  }

  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`

  return null
}
