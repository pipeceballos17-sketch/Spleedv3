/**
 * Slack Block Kit dossier card builder (Sprint 7c).
 *
 * Renders the synthesized Profiler dossier as Slack blocks for the
 * concierge worker's threaded reply. Compact section (header + angle +
 * top 3 hooks) is always present; the Deep Research section is included
 * only when Phase 7 produced findings — Wallace-style empty research
 * shows a 3-source footer and no DR section.
 *
 * Block Kit reference: https://api.slack.com/block-kit
 * Sprint 7d (signals feed) will extend this with actions blocks
 * (interactive buttons); Sprint 8 (Composer) will add a "Draft outreach"
 * button + reference to the generated asset.
 */

import type {
  BuildDossierCardInput,
  DossierCardDeepResearch,
  SlackBlock,
} from './types'

/**
 * True when ANY of the four deep-research categories surfaced a finding.
 * False on a Wallace-style empty dossier — the card builder hides the
 * Deep Research section in that case rather than showing "no findings".
 */
function deepResearchHasFindings(dr: DossierCardDeepResearch): boolean {
  return (
    dr.succession_signals.findings.length > 0 ||
    dr.hiring_signals.findings.length > 0 ||
    dr.tech_stack_signals.findings.length > 0 ||
    dr.recent_activity_signals.findings.length > 0
  )
}

function categoryBlock(
  label: string,
  emoji: string,
  category: DossierCardDeepResearch['succession_signals'],
): SlackBlock[] {
  if (category.findings.length === 0) return []
  // Cap at 4 findings per category to keep the card scannable. Slack
  // mrkdwn handles bullet lists natively via the `•` glyph.
  const bullets = category.findings
    .slice(0, 4)
    .map((f) => `• ${f.signal}`)
    .join('\n')
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${label}*\n${bullets}` },
    },
  ]
}

/**
 * Build the dossier Block Kit message. Block ordering:
 *   1. Header — lead full name
 *   2. Section — `role · company` subtitle
 *   3. Divider
 *   4. Section — 💡 Recommended angle (synthesis output)
 *   5. Divider
 *   6. Section — 🎯 Top Hooks (3 numbered hooks with confidence)
 *   7. (Conditional) Divider + 🔍 Deep Research Findings header + 4 category sections
 *   8. Divider
 *   9. Context — confidence + source count footer
 */
export function buildDossierCard(input: BuildDossierCardInput): SlackBlock[] {
  const { lead, recommendedAngle, confidenceScore, topHooks, deepResearch } = input
  const blocks: SlackBlock[] = []

  // ─── Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: lead.fullName ?? '(pending enrichment)', emoji: true },
  })

  // ─── Subtitle — role · company
  const subtitleParts: string[] = []
  if (lead.role) subtitleParts.push(`*${lead.role}*`)
  if (lead.company) subtitleParts.push(lead.company)
  else if (lead.companyDomain) subtitleParts.push(lead.companyDomain)
  if (subtitleParts.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: subtitleParts.join(' · ') },
    })
  }

  blocks.push({ type: 'divider' })

  // ─── Recommended angle
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `💡 *Recommended angle:*\n${recommendedAngle}` },
  })

  blocks.push({ type: 'divider' })

  // ─── Top hooks — section header + one section per hook
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '🎯 *Top Hooks*' },
  })
  topHooks.slice(0, 3).forEach((hook, i) => {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${i + 1}.* ${hook.hook}\n_Confidence: ${hook.confidence.toFixed(2)}_`,
      },
    })
  })

  // ─── Deep Research section (conditional)
  const showDeepResearch = deepResearch && deepResearchHasFindings(deepResearch)
  if (showDeepResearch && deepResearch) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '🔍 *Deep Research Findings*' },
    })
    blocks.push(...categoryBlock('Succession', '👥', deepResearch.succession_signals))
    blocks.push(...categoryBlock('Hiring', '📈', deepResearch.hiring_signals))
    blocks.push(...categoryBlock('Tech stack', '🛠', deepResearch.tech_stack_signals))
    blocks.push(...categoryBlock('Recent activity', '🎤', deepResearch.recent_activity_signals))
  }

  // ─── Footer — confidence + source count
  blocks.push({ type: 'divider' })
  const sourceCount = showDeepResearch ? '4 sources' : '3 sources'
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Confidence: ${confidenceScore.toFixed(2)} · ${sourceCount}`,
      },
    ],
  })

  return blocks
}
