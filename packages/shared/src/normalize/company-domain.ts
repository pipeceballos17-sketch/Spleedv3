/**
 * Canonical company domain normalization.
 *
 * Sprint 7a — Manual lead ingest accepts company URLs in many shapes
 * (full URL, bare domain, mixed case). Normalizes to lowercase bare
 * domain so soft dedupe lookups and mock fixture lookups (Vercel
 * browser + Apify mocks) hit consistently.
 *
 * Canonical form: lowercase, no protocol, no www, no trailing slash,
 * no path/query/fragment. Just `pulseanalytics.io`.
 *
 * Supported input formats (6+ tested):
 *   1. https://pulseanalytics.io          → pulseanalytics.io
 *   2. https://www.pulseanalytics.io      → pulseanalytics.io
 *   3. pulseanalytics.io                  → pulseanalytics.io
 *   4. PULSEANALYTICS.io                  → pulseanalytics.io
 *   5. pulseanalytics.io/about            → pulseanalytics.io
 *   6. https://pulseanalytics.io?ref=foo  → pulseanalytics.io
 *
 * Invalid inputs ("not a domain", empty string, single token without TLD)
 * return null.
 */

/**
 * Basic domain shape: <label>.<tld>, optionally subdomain.label.tld.
 * Labels are alphanumeric + hyphens. We don't validate TLD against the
 * IANA list (too noisy and breaks on new gTLDs); a 2+ char trailing
 * segment is enough for the dedupe + fixture-lookup use cases.
 */
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

export function normalizeCompanyDomain(input: string | null | undefined): string | null {
  if (!input) return null
  let normalized = input.trim().toLowerCase()
  if (normalized.length === 0) return null

  // Strip protocol if present.
  normalized = normalized.replace(/^https?:\/\//, '')

  // Strip www. prefix.
  normalized = normalized.replace(/^www\./, '')

  // Strip path / query / fragment — take only the host portion.
  normalized = normalized.split('/')[0]!.split('?')[0]!.split('#')[0]!

  // Trailing dot rarely seen but legal in DNS — strip for canonical form.
  normalized = normalized.replace(/\.$/, '')

  if (normalized.length === 0) return null
  if (!DOMAIN_RE.test(normalized)) return null

  return normalized
}
