/**
 * ICP starter guidance — recommendedSources tests (Sprint 9 CP3 — 4 tests).
 *
 * mockGenerateIcpStarterGuidance is the Hermes-generated source catalog: it
 * derives a per-vertical list of public data sources (no hardcoded adapters).
 * Horizontal-honest: a generic ICP yields [] rather than guessed sources.
 */

import { describe, expect, it } from 'bun:test'
import { mockGenerateIcpStarterGuidance } from '../mock'

const ids = (hint: string): string[] =>
  mockGenerateIcpStarterGuidance(hint).recommendedSources.map((s) => s.id)

describe('mockGenerateIcpStarterGuidance.recommendedSources (Sprint 9 CP3)', () => {
  it('factoring/lending → sec_edgar + ucc_state + fmcsa_socrata', () => {
    const got = ids('Invoice factoring lenders and credit providers in LatAm')
    expect(got).toContain('sec_edgar')
    expect(got).toContain('ucc_state')
    expect(got).toContain('fmcsa_socrata')
  })

  it('education → icfes + men_registry', () => {
    const got = ids('Directors of bilingual private schools in Colombia')
    expect(got).toContain('icfes')
    expect(got).toContain('men_registry')
  })

  it('saas/startup → crunchbase + github_org + tech_press', () => {
    const got = ids('B2B SaaS software startup founders, seed stage, US')
    expect(got).toContain('crunchbase')
    expect(got).toContain('github_org')
    expect(got).toContain('tech_press')
  })

  it('generic ICP → recommendedSources [] (honest horizontal, no guessing)', () => {
    expect(mockGenerateIcpStarterGuidance('Operations managers at mid-market firms').recommendedSources).toEqual([])
  })
})
