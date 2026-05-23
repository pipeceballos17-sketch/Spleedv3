/**
 * Canonical LinkedIn URL normalization.
 *
 * Sprint 7a — Manual lead ingest (POST /api/leads/ingest) accepts a wide
 * variety of LinkedIn input shapes from founders pasting URLs, handles, or
 * copy/paste fragments. This helper normalizes to one canonical shape so:
 *   - Soft dedupe lookup (leads.linkedin_url unique index) hits consistently
 *   - Apify mock fixtures (Sprint 6b) match curated keys deterministically
 *   - Cross-source signal joins (LinkedIn ↔ news ↔ company website) align
 *
 * Canonical form: `https://linkedin.com/in/<handle>` (no www, no trailing
 * slash, no query string, no fragment, no /detail/ subpath).
 *
 * Supported input formats (7+ tested):
 *   1. https://www.linkedin.com/in/sarah-chen   → canonical
 *   2. https://linkedin.com/in/sarah-chen/      → canonical (trailing slash stripped)
 *   3. linkedin.com/in/sarah-chen               → canonical (protocol added)
 *   4. www.linkedin.com/in/sarah-chen           → canonical (www + protocol)
 *   5. sarah-chen                               → canonical (bare handle)
 *   6. @sarah-chen                              → canonical (@ stripped)
 *   7. https://www.linkedin.com/in/sarah-chen?utm_source=foo → canonical (query stripped)
 *
 * Non-LinkedIn inputs return null (caller decides whether to fall back to
 * companyDomain or reject the ingest).
 */

const LINKEDIN_HOST_RE = /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([^/?#\s]+)/i

/**
 * Bare-handle matcher. LinkedIn handles allow letters, digits, hyphens,
 * underscores, and a small set of unicode characters. We accept the
 * conservative ASCII subset for the bare-handle path; full URLs handed
 * through LINKEDIN_HOST_RE pass any character LinkedIn itself accepts.
 */
const BARE_HANDLE_RE = /^@?([A-Za-z0-9_-]{3,100})$/

export function normalizeLinkedinUrl(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  // Path 1 — full URL (any protocol/www variant)
  const urlMatch = trimmed.match(LINKEDIN_HOST_RE)
  if (urlMatch) {
    const handle = urlMatch[1]!
    return `https://linkedin.com/in/${handle}`
  }

  // Path 2 — bare handle (with or without @ prefix)
  const handleMatch = trimmed.match(BARE_HANDLE_RE)
  if (handleMatch) {
    return `https://linkedin.com/in/${handleMatch[1]!}`
  }

  // Non-LinkedIn URL or unparseable — caller chooses fallback.
  return null
}
