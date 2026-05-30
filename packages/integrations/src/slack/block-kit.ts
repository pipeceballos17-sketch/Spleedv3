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
  BuildApprovalCardInput,
  BuildDossierCardInput,
  BuildReplyNotificationCardInput,
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

/**
 * Render a 📞 Contact section (Sprint 8.2). Shows whichever of email / phone /
 * LinkedIn are present; when all are absent, a single warning line prompts the
 * founder to add contact data. LinkedIn URL is a display key, not a channel.
 */
function contactSection(contact: {
  email?: string | null
  phone?: string | null
  linkedinUrl?: string | null
}): SlackBlock[] {
  const { email, phone, linkedinUrl } = contact
  if (!email && !phone && !linkedinUrl) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '📞 *Contact*\n_No contact data extracted yet — manual update may be needed._' },
      },
    ]
  }
  const lines = [
    `• Email: ${email ?? '_not extracted_'}`,
    `• Phone: ${phone ?? '_not extracted_'}`,
    `• LinkedIn: ${linkedinUrl ?? '_not provided_'}`,
  ]
  return [{ type: 'section', text: { type: 'mrkdwn', text: `📞 *Contact*\n${lines.join('\n')}` } }]
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

  // ─── Contact (Sprint 8.2)
  blocks.push(...contactSection({ email: lead.email, phone: lead.phone, linkedinUrl: lead.linkedinUrl }))

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

/**
 * Build the Composer draft approval card (Sprint 8). Posted as a threaded
 * reply when a draft reaches 'pending_approval'. Block ordering:
 *   1. Header — "📝 Draft ready for {lead}"
 *   2. (email) Section — subject line
 *   3. Section — the draft body (mrkdwn)
 *   4. Context — voice summary · cost · channel
 *   5. Actions — Approve & Send / Edit / Regenerate / Reject
 *
 * The four buttons carry the draftId as `value`; POST /api/slack/interactions
 * routes by action_id. Approve is `primary` (green), Reject is `danger` (red).
 */
export function buildApprovalCard(input: BuildApprovalCardInput): SlackBlock[] {
  const { draftId, leadName, channel, subject, body, voiceSummary, costUsd } = input
  const blocks: SlackBlock[] = []

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📝 Draft ready for ${leadName}`, emoji: true },
  })

  // ─── Phase 0 channel recommendation (Sprint 8.2)
  if (input.channelReasoning) {
    const conf = typeof input.channelConfidence === 'number' ? ` (confidence ${input.channelConfidence.toFixed(2)})` : ''
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🎯 *Recommended channel: ${channel.toUpperCase()}*\n_${input.channelReasoning}_${conf}` },
    })
  }

  // ─── Contact data
  if (input.contact) {
    blocks.push(...contactSection(input.contact))
  }

  if (channel === 'email' && subject) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Subject:* ${subject}` },
    })
  }

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body } })

  const footerParts = [
    voiceSummary ? `Voice: ${voiceSummary}` : null,
    `Cost: $${costUsd.toFixed(4)}`,
    `Channel: ${channel}`,
  ].filter((p): p is string => p !== null)
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: footerParts.join(' · ') }],
  })

  blocks.push({
    type: 'actions',
    block_id: `draft_actions_${draftId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Approve & Send', emoji: true },
        action_id: 'approve_draft',
        value: draftId,
        style: 'primary',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
        action_id: 'edit_draft',
        value: draftId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔄 Regenerate', emoji: true },
        action_id: 'regenerate_draft',
        value: draftId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌ Reject', emoji: true },
        action_id: 'reject_draft',
        value: draftId,
        style: 'danger',
      },
    ],
  })

  return blocks
}

/**
 * Build the inbound-reply notification card (Sprint 8.2). Posted as a threaded
 * reply when a lead responds. 'engaged' replies surface 3 action buttons
 * (Mark engaged / Draft reply / Archive); 'declined' and 'other' are FYI-only
 * (no buttons). Unsubscribe replies are handled separately (plain message) and
 * don't use this card.
 */
export function buildReplyNotificationCard(input: BuildReplyNotificationCardInput): SlackBlock[] {
  const { replyId, leadName, replyBody, intent } = input
  const blocks: SlackBlock[] = []

  const headerText =
    intent === 'engaged' ? `🎉 ${leadName} replied!` : `📬 ${leadName} replied`
  blocks.push({ type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } })

  // Quote the reply body (cap length to keep the card scannable).
  const quoted = replyBody.length > 600 ? `${replyBody.slice(0, 600)}…` : replyBody
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `> ${quoted.replace(/\n/g, '\n> ')}` },
  })

  if (intent === 'engaged') {
    blocks.push({
      type: 'actions',
      block_id: `reply_actions_${replyId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Mark as engaged', emoji: true },
          action_id: 'mark_engaged',
          value: replyId,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📝 Draft reply', emoji: true },
          action_id: 'draft_reply',
          value: replyId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🗂 Archive', emoji: true },
          action_id: 'archive_reply',
          value: replyId,
        },
      ],
    })
  } else {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Intent: ${intent} · no action needed` }],
    })
  }

  return blocks
}
