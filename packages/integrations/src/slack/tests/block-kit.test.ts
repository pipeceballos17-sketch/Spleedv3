/**
 * buildDossierCard test suite (Sprint 7c — 2 tests).
 *
 * Pure rendering tests over the Block Kit dossier card. Sarah exercises the
 * full 4-source + deep-research card; Wallace exercises the empty-deep-
 * research graceful path (section hidden, 3-source footer).
 */

import { describe, expect, it } from 'bun:test'
import { buildDossierCard } from '../block-kit'
import type { BuildDossierCardInput, SlackBlock } from '../types'

function headerText(blocks: SlackBlock[]): string | undefined {
  const h = blocks.find((b) => b.type === 'header')
  return h?.type === 'header' ? h.text.text : undefined
}

function sectionTexts(blocks: SlackBlock[]): string[] {
  return blocks
    .filter((b): b is Extract<SlackBlock, { type: 'section' }> => b.type === 'section')
    .map((b) => b.text.text)
}

function footerText(blocks: SlackBlock[]): string | undefined {
  const ctx = blocks.find((b) => b.type === 'context')
  return ctx?.type === 'context' ? ctx.elements[0]?.text : undefined
}

describe('buildDossierCard — Sprint 7c', () => {
  it('Sarah full enrichment (4 sources + deep research) → ~17 blocks, all sections present', () => {
    const input: BuildDossierCardInput = {
      lead: {
        fullName: 'Sarah Chen',
        role: 'Founder & CEO',
        company: 'Pulse Analytics',
        companyDomain: 'pulseanalytics.io',
        email: 'sarah@pulseanalytics.io',
        linkedinUrl: 'https://linkedin.com/in/sarahchen',
      },
      recommendedAngle:
        "Tie Sarah's Series A to Brian's CSO appointment as evidence of a deliberate scaling playbook.",
      confidenceScore: 0.95,
      topHooks: [
        { hook: 'Pulse just closed $14M Series A with Costanoa', confidence: 0.93 },
        { hook: 'Hiring Founding AE in SF — fresh GTM build', confidence: 0.88 },
        { hook: 'Sarah speaking at SaaStr next month', confidence: 0.78 },
      ],
      deepResearch: {
        succession_signals: { findings: [{ signal: 'Brian Chen joined as CSO post Series A' }] },
        hiring_signals: { findings: [{ signal: '5 GTM roles posted' }] },
        tech_stack_signals: { findings: [{ signal: 'Migrating Pipedrive → Salesforce' }] },
        recent_activity_signals: { findings: [{ signal: 'Keynoted SaaStr 2025' }] },
      },
    }

    const blocks = buildDossierCard(input)

    // Full card: header + subtitle + contact + 2 dividers + angle +
    // hooks-header + 3 hooks + DR divider + DR header + 4 category sections +
    // footer divider + footer = 18 (Sprint 8.2 added the contact section).
    expect(blocks.length).toBe(18)
    expect(headerText(blocks)).toBe('Sarah Chen')

    const sections = sectionTexts(blocks)
    // Contact section shows the lead's email.
    expect(sections.some((s) => s.includes('Contact') && s.includes('sarah@pulseanalytics.io'))).toBe(true)
    expect(sections.some((s) => s.includes('Recommended angle'))).toBe(true)
    expect(sections.some((s) => s.includes('Top Hooks'))).toBe(true)
    expect(sections.some((s) => s.includes('Deep Research Findings'))).toBe(true)
    // All four deep-research categories rendered.
    expect(sections.some((s) => s.includes('Succession'))).toBe(true)
    expect(sections.some((s) => s.includes('Hiring'))).toBe(true)
    expect(sections.some((s) => s.includes('Tech stack'))).toBe(true)
    expect(sections.some((s) => s.includes('Recent activity'))).toBe(true)

    // Footer reflects 4 sources (deep research ran) + confidence.
    expect(footerText(blocks)).toContain('4 sources')
    expect(footerText(blocks)).toContain('0.95')
  })

  it('Wallace empty deep research → ~8 blocks, DR section hidden, 3-source footer', () => {
    const input: BuildDossierCardInput = {
      lead: {
        fullName: 'Henry Wallace',
        role: 'Plant Manager',
        company: 'Wallace Steel Co.',
        companyDomain: 'wallacesteel.com',
      },
      recommendedAngle: 'No outreach angle surfaced — dossier is thin.',
      confidenceScore: 0,
      topHooks: [],
      deepResearch: {
        succession_signals: { findings: [] },
        hiring_signals: { findings: [] },
        tech_stack_signals: { findings: [] },
        recent_activity_signals: { findings: [] },
      },
    }

    const blocks = buildDossierCard(input)

    // header + subtitle + contact (no-data warning) + 2 dividers + angle +
    // hooks-header (0 hooks) + footer divider + footer = 9 (Sprint 8.2 contact).
    expect(blocks.length).toBe(9)
    expect(headerText(blocks)).toBe('Henry Wallace')

    const sections = sectionTexts(blocks)
    expect(sections.some((s) => s.includes('Deep Research Findings'))).toBe(false)
    // No contact data → warning section.
    expect(sections.some((s) => s.includes('No contact data extracted yet'))).toBe(true)

    // Footer reflects 3 sources (deep research produced nothing).
    expect(footerText(blocks)).toContain('3 sources')
  })
})
