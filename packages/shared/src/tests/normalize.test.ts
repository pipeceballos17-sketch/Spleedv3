/**
 * Sprint 7a normalize helpers unit tests.
 *
 * Pure functions, no DB or env required. Run via `bun --env-file=...` in
 * the package's `test` script so the env loader matches other packages,
 * but the tests themselves don't read anything from env.
 */

import { describe, expect, it } from 'bun:test'
import { normalizeCompanyDomain, normalizeLinkedinUrl } from '../normalize'

describe('normalizeLinkedinUrl', () => {
  it('accepts 7+ input formats and emits canonical URL or null', () => {
    const cases: Array<[unknown, string | null]> = [
      // 1. Full URL with www
      ['https://www.linkedin.com/in/sarah-chen', 'https://linkedin.com/in/sarah-chen'],
      // 2. Trailing slash stripped
      ['https://linkedin.com/in/sarah-chen/', 'https://linkedin.com/in/sarah-chen'],
      // 3. Bare URL (no protocol)
      ['linkedin.com/in/sarah-chen', 'https://linkedin.com/in/sarah-chen'],
      // 4. www without protocol
      ['www.linkedin.com/in/sarah-chen', 'https://linkedin.com/in/sarah-chen'],
      // 5. Bare handle
      ['sarah-chen', 'https://linkedin.com/in/sarah-chen'],
      // 6. @ handle
      ['@sarah-chen', 'https://linkedin.com/in/sarah-chen'],
      // 7. URL with query string stripped
      [
        'https://www.linkedin.com/in/sarah-chen?utm_source=foo',
        'https://linkedin.com/in/sarah-chen',
      ],
      // Negative cases — return null
      ['', null],
      [null, null],
      [undefined, null],
      ['https://example.com', null],
      ['not a handle', null],
      // Edge: linkedin.com without /in/ path is NOT a profile URL
      ['linkedin.com/sarah-chen', null],
    ]
    for (const [input, expected] of cases) {
      expect(normalizeLinkedinUrl(input as string)).toBe(expected as string)
    }
  })

  it('is deterministic — same input → same output across calls', () => {
    const url = 'https://linkedin.com/in/sarah-chen'
    expect(normalizeLinkedinUrl(url)).toBe(normalizeLinkedinUrl(url))
    expect(normalizeLinkedinUrl('@sarah-chen')).toBe(normalizeLinkedinUrl('sarah-chen'))
  })
})

describe('normalizeCompanyDomain', () => {
  it('accepts 6+ input formats and emits lowercase bare domain or null', () => {
    const cases: Array<[unknown, string | null]> = [
      // 1. Full URL
      ['https://pulseanalytics.io', 'pulseanalytics.io'],
      // 2. Full URL with www
      ['https://www.pulseanalytics.io', 'pulseanalytics.io'],
      // 3. Bare domain
      ['pulseanalytics.io', 'pulseanalytics.io'],
      // 4. Mixed-case lowercased
      ['PULSEANALYTICS.io', 'pulseanalytics.io'],
      // 5. URL with path stripped
      ['pulseanalytics.io/about', 'pulseanalytics.io'],
      // 6. URL with query stripped
      ['https://pulseanalytics.io?ref=foo', 'pulseanalytics.io'],
      // 7. Trailing dot stripped
      ['pulseanalytics.io.', 'pulseanalytics.io'],
      // 8. Subdomain preserved
      ['blog.pulseanalytics.io', 'blog.pulseanalytics.io'],
      // Negative cases — return null
      ['not a domain', null],
      ['', null],
      [null, null],
      [undefined, null],
      // Single token without TLD
      ['localhost', null],
    ]
    for (const [input, expected] of cases) {
      expect(normalizeCompanyDomain(input as string)).toBe(expected as string)
    }
  })
})
