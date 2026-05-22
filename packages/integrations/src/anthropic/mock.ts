import type { ExtractedCompanyWebsiteSignals, ScoreLeadInput } from './types'

/**
 * Deterministic LLM mock — pure function of (candidate, icp, sqlScore).
 * Tests rely on stable outputs; we synthesize "noise" by hashing the
 * candidate id rather than calling Math.random(), so the same input always
 * produces the same output.
 *
 * Scoring model (Sprint 5b approximation):
 *   start    = sqlScore
 *   bonus    = +10 if candidate.industry exactly matches any ICP industry,
 *              -5 if ICP specifies industries but candidate doesn't match
 *   noise    = deterministic ±3 derived from candidate.id char-sum mod 7 − 3
 *   llmScore = clamp(start + bonus + noise, 0, 100)
 *
 * Sprint 7 replaces this with real Anthropic calls. The fixture intent is
 * to surface "LLM moved the needle" so dashboard regressions are visible.
 */
export function mockScoreLead(input: ScoreLeadInput): {
  llmScore: number
  reasoning: string
} {
  const { icp, candidate, sqlScore } = input

  const icpIndustries = (icp.parsedFilters.industries ?? []).map((s) => s.toLowerCase())
  let bonus = 0
  let reasoningHint = 'baseline'

  if (icpIndustries.length > 0) {
    if (candidate.industry && icpIndustries.includes(candidate.industry.toLowerCase())) {
      bonus = 10
      reasoningHint = 'industry exact match'
    } else {
      bonus = -5
      reasoningHint = 'industry mismatch vs ICP'
    }
  }

  // Deterministic ±3 from candidate id. Sum char codes mod 7, subtract 3 to
  // center on zero. Same candidate always lands on the same offset.
  const charSum = [...candidate.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  const noise = (charSum % 7) - 3

  const llmScore = Math.min(100, Math.max(0, sqlScore + bonus + noise))
  const reasoning = `Mock: SQL ${sqlScore} → LLM ${llmScore} (${reasoningHint}, noise ${noise >= 0 ? '+' : ''}${noise}).`

  return { llmScore, reasoning }
}

/**
 * Mock token counts — realistic enough for cost_events parity in tests
 * without pretending to match true Anthropic billing. Prompt size in
 * Sprint 5b is ~200 input tokens (ICP + candidate compact format) and ~80
 * output tokens (JSON answer).
 */
export const MOCK_TOKENS_IN = 200
export const MOCK_TOKENS_OUT = 80

/**
 * Mock latency: deterministic 200-800ms band derived from candidate id, so
 * the same candidate yields the same latency on every run.
 */
export function mockLatencyMs(candidateId: string): number {
  const charSum = [...candidateId].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 200 + (charSum % 600)
}

// ─── Profiler (Sprint 6a) — company-website extraction mock ────────────

/**
 * Curated extraction signals per domain. Keys MUST match the domains
 * registered in vercel-browser/mock.ts so end-to-end Scout → Profiler
 * tests stay coherent (page text → extracted signals roughly aligned).
 *
 * Confidence values (0.7-0.95) mimic what a real Sonnet 4.6 extraction
 * would surface. Domains absent from this map fall through to the empty
 * fallback in mockExtractCompanyWebsiteSignals — Profiler then writes a
 * dossier with empty arrays + company_stage='unknown' rather than failing.
 */
const MOCK_COMPANY_SIGNALS: Record<string, ExtractedCompanyWebsiteSignals> = {
  'pulseanalytics.io': {
    company_stage: 'series-a',
    recent_news: [
      'Series A $14M raised July 2025 (Costanoa Ventures lead)',
      'New Stripe Billing integration announced Q2 2026',
      'Y Combinator alumni demo participation',
    ],
    pain_signals: [
      'Customers stitch together Mixpanel + Heap + custom warehouses for product analytics',
      'Founder time consumed by analytics tooling rather than shipping',
    ],
    hiring_signals: [
      'Hiring Senior Product Engineer',
      'Hiring Founding Account Executive (US)',
      'Hiring Customer Success Lead',
    ],
    growth_signals: [
      '240+ scaling startups in customer base',
      'Customers reduce churn by 18% in first quarter',
      'Series A $14M closed July 2025',
    ],
    hook_candidates: [
      {
        hook: 'Pulse just closed Series A with Costanoa — Sarah is likely scaling go-to-market fast',
        evidence: 'Series A led by Costanoa Ventures, July 2025. Team of 12 across San Francisco and remote.',
        confidence: 0.88,
      },
      {
        hook: 'Pulse hiring a Founding AE — outbound motion is being built right now',
        evidence: 'We are hiring: Senior Product Engineer, Founding Account Executive (US), Customer Success Lead.',
        confidence: 0.82,
      },
    ],
  },
  'mosaicinbox.com': {
    company_stage: 'seed',
    recent_news: [
      'Mosaic launched beta March 2026',
      'First paid customer signed last week',
    ],
    pain_signals: [
      'Founder-led support teams drop context across Email/Slack/Intercom threads',
      'Early-stage founders still handling half the support tickets',
    ],
    hiring_signals: [],
    growth_signals: ['First paid customer signed', '8 design partners shipping with the team'],
    hook_candidates: [
      {
        hook: 'Mosaic just signed first paid customer — Priya is in pure founder-led sales mode right now',
        evidence: 'First paid customer signed last week.',
        confidence: 0.85,
      },
    ],
  },
  'colegiosanandres.edu.co': {
    company_stage: 'enterprise',
    recent_news: [
      'Marzo 2026: convenio con Universidad EAFIT para articulación de programas',
      'Octubre 2025: renovación de acreditación ICFES por cinco años',
      '14 estudiantes graduados con becas internacionales en 2025',
    ],
    pain_signals: [
      'Preparación universitaria competitiva como diferencial',
      'Seguimiento de placement universitario post-grado',
    ],
    hiring_signals: [],
    growth_signals: [
      'Acreditación ICFES nivel A+',
      'Más de 1,400 estudiantes y 120 docentes',
      'Convenio EAFIT firmado 2026',
    ],
    hook_candidates: [
      {
        hook: 'Colegio firmó articulación con EAFIT — Laura puede necesitar tooling para tracking de placement universitario',
        evidence: 'Marzo 2026: el colegio firma convenio con Universidad EAFIT para articulación de programas.',
        confidence: 0.78,
      },
    ],
  },
  'andeanfactoring.co': {
    company_stage: 'growth',
    recent_news: ['Enero 2026: línea de crédito de COP 50 mil millones con Bancolombia'],
    pain_signals: [
      'PYMES en Colombia necesitan capital de trabajo rápido',
      'Workflows de factoring probablemente manuales en sectores tradicionales',
    ],
    hiring_signals: [],
    growth_signals: [
      '18 años en el mercado, calificación BRC1+',
      'Expansión a Eje Cafetero respaldada por nueva línea Bancolombia',
    ],
    hook_candidates: [
      {
        hook: 'Andean acaba de cerrar línea de COP 50B con Bancolombia — Diego está expandiendo distribución en Eje Cafetero',
        evidence:
          'Enero 2026: Andean firma línea de crédito con Bancolombia por COP 50 mil millones para ampliar operaciones en el Eje Cafetero.',
        confidence: 0.86,
      },
    ],
  },
  'careloophealth.com': {
    company_stage: 'series-b',
    recent_news: [
      'November 2025: Series B $42M closed (General Catalyst lead, a16z Bio participation)',
      'February 2026: Atrium Health partnership — 12 hospitals Carolinas',
    ],
    pain_signals: [
      '30-day hospital readmission rates pressure health-system economics',
      'Discharge-to-home coordination breaks across phone/fax workflows',
    ],
    hiring_signals: [
      'Hiring VP of Sales (Atlanta or remote)',
      'Hiring Enterprise Account Executive',
      'Hiring Clinical Implementation Manager',
    ],
    growth_signals: [
      '38 health-system partners',
      '22% average readmission reduction',
      'Series B $42M raised',
      'Expansion to 12 hospitals in Carolinas',
    ],
    hook_candidates: [
      {
        hook: 'CareLoop is hiring a VP of Sales — Rebecca is actively scaling commercial post-Series B',
        evidence: 'Currently hiring: VP of Sales (Atlanta or remote), Enterprise Account Executive, Clinical Implementation Manager.',
        confidence: 0.92,
      },
      {
        hook: 'CareLoop expanding to Carolinas with Atrium — fresh distribution motion to enable',
        evidence: 'February 2026: CareLoop launches new partnership with Atrium Health, expanding to 12 hospitals in the Carolinas.',
        confidence: 0.84,
      },
    ],
  },
  // Wallace Steel — intentionally signal-sparse to exercise the graceful
  // degradation path. Profiler should still produce a valid (empty) dossier
  // and not error.
  'wallacesteel.com': {
    company_stage: 'enterprise',
    recent_news: [],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: [],
    hook_candidates: [],
  },
  'halocreative.co': {
    company_stage: 'growth',
    recent_news: [
      'February 2026: $1.5M ARR milestone after 12-month doubling',
      'March 2026: Won Trove Insurance account from incumbent Mekanism',
    ],
    pain_signals: [
      'Most agencies pick brand OR paid media — Halo blends both',
    ],
    hiring_signals: [
      'Hiring Senior Paid Social Lead',
      'Hiring Brand Strategist',
      'Hiring Director of Client Services',
    ],
    growth_signals: [
      '$1.5M ARR milestone',
      '12-month revenue doubling',
      'Won Trove Insurance from Mekanism',
      '22 funded consumer brand clients',
    ],
    hook_candidates: [
      {
        hook: 'Halo just won Trove from Mekanism — Jasmine in active scale mode',
        evidence: 'March 2026: Halo wins Trove Insurance account from incumbent Mekanism.',
        confidence: 0.83,
      },
    ],
  },
}

/**
 * Empty-but-valid signals. Used when no curated mock exists for a domain.
 * Profiler should treat this as a successful enrichment with zero hooks —
 * dossier row is created, lead.status='enriched', and the founder simply
 * sees a thin dossier rather than a failure.
 */
const EMPTY_SIGNALS: ExtractedCompanyWebsiteSignals = {
  company_stage: 'unknown',
  recent_news: [],
  pain_signals: [],
  hiring_signals: [],
  growth_signals: [],
  hook_candidates: [],
}

/**
 * Deterministic mock for AnthropicClient.extractCompanyWebsiteSignals.
 * Mirrors mockScoreLead's purity: same input → same output, no clock or
 * Math.random. Lookup by domainHint (case-insensitive). Returns EMPTY_SIGNALS
 * for unknown domains so callers don't crash.
 */
export function mockExtractCompanyWebsiteSignals(input: {
  domainHint?: string
}): ExtractedCompanyWebsiteSignals {
  const key = input.domainHint?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0] ?? ''
  return MOCK_COMPANY_SIGNALS[key] ?? EMPTY_SIGNALS
}

/**
 * Token estimates for Profiler extraction. Realistic enough for cost_events
 * parity without pretending to match true Anthropic billing.
 *   - input: PROFILER_SYSTEM_PROMPT (~250 tokens) + pageContent (~1300) + ICP (~150) + scaffolding (~100)
 *   - output: structured JSON with 5 arrays + 2-3 hooks (~500 tokens)
 */
export const MOCK_PROFILER_TOKENS_IN = 1800
export const MOCK_PROFILER_TOKENS_OUT = 500

/**
 * Profiler-flavored mock latency: 1500-3000ms band derived from the hint,
 * deterministic per hint so re-runs stay stable. Wider than mockLatencyMs
 * because real extraction calls are heavier than re-rank scoring.
 */
export function mockProfilerLatencyMs(hint: string): number {
  const charSum = [...hint].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 1500 + (charSum % 1500)
}

export { MOCK_COMPANY_SIGNALS, EMPTY_SIGNALS }
