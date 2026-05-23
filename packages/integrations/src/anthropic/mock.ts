import type {
  ExtractedCompanyWebsiteSignals,
  ExtractedLinkedinSignals,
  ExtractedNewsSignals,
  ProfilerSourceName,
  ScoreLeadInput,
  SynthesizedDossierJson,
} from './types'

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

// ─── Profiler (Sprint 6b) — LinkedIn extraction mock ────────────────

/**
 * Curated LinkedIn extraction signals keyed by normalized LinkedIn URL.
 * Keys match the profile URLs in @spleed/integrations/apify/mock.ts so
 * end-to-end Profiler tests get coherent signals (the Apify mock returns
 * a profile, the Anthropic mock returns what extraction would surface
 * from that profile + posts).
 *
 * Cross-source dedupe demo: Sarah's Series A and Rebecca's Atrium deal
 * intentionally appear here AND in MOCK_COMPANY_SIGNALS AND in
 * MOCK_NEWS_SIGNALS — synthesis (see MOCK_SYNTHESIS_DOSSIERS below)
 * collapses these into single dedup'd hooks.
 */
const MOCK_LINKEDIN_SIGNALS: Record<string, ExtractedLinkedinSignals> = {
  'linkedin.com/in/sarahchen': {
    company_stage: 'series-a',
    recent_news: [
      'Sarah Chen announces $14M Series A on LinkedIn (3 days ago, 412 reactions)',
      'Speaking slot at SaaStr announced for next month (28 days ago)',
    ],
    pain_signals: [
      'Existing product analytics stack costs $40K/yr for basic activation questions',
      'Activation metrics that move retention vs vanity metrics confusion in board decks',
    ],
    hiring_signals: [
      'Hiring Founding AE in SF (open DM in the post)',
      'Engineering + GTM + customer success roles open per LinkedIn About',
    ],
    growth_signals: [
      '240+ scaling startups in customer base (mentioned in About)',
      'Segment self-serve revenue 8% → 31% under Sarah\'s prior PM tenure',
    ],
    hook_candidates: [
      {
        hook: 'Sarah just closed $14M Series A with Costanoa — outbound motion is in active build',
        evidence: 'We just closed our $14M Series A led by Costanoa Ventures. ... Hiring our Founding AE in SF — DM me if you want to build the GTM motion from scratch.',
        confidence: 0.92,
      },
      {
        hook: 'Speaking at SaaStr next month on activation metrics — public POV worth referencing',
        evidence: 'Speaking at SaaStr next month on the difference between activation metrics that move retention vs the ones that just look good in board decks.',
        confidence: 0.8,
      },
    ],
  },
  'linkedin.com/in/priyaiyer': {
    company_stage: 'seed',
    recent_news: ['Priya announces first paid customer signed (7 days ago)'],
    pain_signals: [
      'Founder-led support means dropping context across Slack/Email/Intercom',
      'Founder still asking "wait what did Slack say last week"',
    ],
    hiring_signals: [],
    growth_signals: ['First paid customer — 8 design partners converted to 1 wallet'],
    hook_candidates: [
      {
        hook: 'Mosaic just signed first paid customer — pure founder-led sales mode',
        evidence: 'First paid Mosaic customer signed. Eight design partners → one wallet pull. Onwards.',
        confidence: 0.87,
      },
    ],
  },
  'linkedin.com/in/lauraperezedu': {
    company_stage: 'enterprise',
    recent_news: [
      'Convenio Colegio San Andrés ↔ Universidad EAFIT anunciado (21 días)',
    ],
    pain_signals: ['Preparación universitaria competitiva como diferencial principal'],
    hiring_signals: [],
    growth_signals: ['Convenio EAFIT como nueva ruta directa para egresados'],
    hook_candidates: [
      {
        hook: 'Laura acaba de anunciar el convenio EAFIT — necesita tooling para tracking de placement',
        evidence: 'Orgullosa de anunciar el convenio entre Colegio San Andrés y Universidad EAFIT para articulación académica. Cinco años en construcción.',
        confidence: 0.79,
      },
    ],
  },
  'linkedin.com/in/rebeccalin': {
    company_stage: 'series-b',
    recent_news: [
      'CareLoop signs Atrium Health expansion (5 days ago)',
    ],
    pain_signals: [
      'Hospital GTM hiring is hard — VP Sales actively recruiting via LinkedIn',
    ],
    hiring_signals: [
      'Hiring 2 enterprise AEs (5 days ago post)',
      'Hiring clinical implementation lead',
    ],
    growth_signals: [
      '22% readmission reduction becoming standard CFO conversation',
      'CareLoop signed Atrium Health (12 hospitals)',
    ],
    hook_candidates: [
      {
        hook: 'CareLoop signed Atrium Health expansion + hiring 2 AEs — Rebecca scaling commercial fast',
        evidence: 'CareLoop just signed Atrium Health — 12 hospitals across the Carolinas. Hiring 2 enterprise AEs and a clinical implementation lead to handle the expansion.',
        confidence: 0.93,
      },
    ],
  },
  'linkedin.com/in/jasminepark': {
    company_stage: 'growth',
    recent_news: [
      'Halo wins Trove Insurance from Mekanism (10 days ago)',
      '$1.5M ARR milestone reached (10 days ago)',
    ],
    pain_signals: [],
    hiring_signals: ['Hiring Senior Paid Social Lead + Brand Strategist'],
    growth_signals: [
      '$1.5M ARR milestone',
      '12-month doubling',
      'Won Trove Insurance from Mekanism',
    ],
    hook_candidates: [
      {
        hook: 'Halo just won Trove Insurance from Mekanism + hit $1.5M ARR — Jasmine in active scale',
        evidence: 'Halo just won Trove Insurance from Mekanism. Twelve-month doubling for the agency, $1.5M ARR milestone last week.',
        confidence: 0.86,
      },
    ],
  },
  // Diego Restrepo + Henry Wallace — empty / sparse. Diego has one
  // Bancolombia line entry, Henry has nothing (graceful).
  'linkedin.com/in/diegorestrepo': {
    company_stage: 'growth',
    recent_news: ['Bancolombia COP 50B credit line anunciada (45 días)'],
    pain_signals: ['PYMES de Eje Cafetero como nuevo mercado de expansión'],
    hiring_signals: [],
    growth_signals: ['Línea Bancolombia COP 50B para expansión Eje Cafetero'],
    hook_candidates: [
      {
        hook: 'Andean cerró línea Bancolombia COP 50B — expansión a Eje Cafetero en curso',
        evidence: 'Nueva línea de crédito con Bancolombia por COP 50 mil millones. Llevamos factoring a las PYMES del Eje Cafetero.',
        confidence: 0.83,
      },
    ],
  },
  'linkedin.com/in/henrywallace': {
    company_stage: 'enterprise',
    recent_news: [],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: [],
    hook_candidates: [],
  },
}

export function mockExtractLinkedinSignals(input: {
  linkedinUrlHint?: string
}): ExtractedLinkedinSignals {
  const raw = input.linkedinUrlHint ?? ''
  const key = raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
  return MOCK_LINKEDIN_SIGNALS[key] ?? EMPTY_SIGNALS
}

// ─── Profiler (Sprint 6b) — News extraction mock ────────────────────

/**
 * Curated news extraction signals keyed by company domain (matches the
 * MOCK_NEWS_ARTICLES keys in @spleed/integrations/vercel-browser/mock.ts).
 * News-extraction prompt emphasizes recent_news + growth_signals; pain
 * signals are rarely surfaced by news coverage (use company website +
 * LinkedIn for those).
 */
const MOCK_NEWS_SIGNALS: Record<string, ExtractedNewsSignals> = {
  'pulseanalytics.io': {
    company_stage: 'series-a',
    recent_news: [
      'Pulse Analytics raises $14M Series A (TechCrunch, July 2025)',
      'Sarah Chen interview on B2B product analytics rethink (SaaStr, 35 days ago)',
    ],
    pain_signals: [
      'Current product analytics stack (Mixpanel + Heap + warehouse) fails for product-led growth teams',
    ],
    hiring_signals: [],
    growth_signals: [
      'Series A $14M closed July 2025 (Costanoa lead)',
      'Y Combinator alumni participation',
    ],
    hook_candidates: [
      {
        hook: 'TechCrunch covered Pulse Series A in July 2025 — strong public signal of momentum',
        evidence: 'The B2B product analytics startup founded by ex-Segment PM Sarah Chen closed a $14M Series A led by Costanoa Ventures.',
        confidence: 0.91,
      },
    ],
  },
  'mosaicinbox.com': {
    company_stage: 'seed',
    recent_news: ['Mosaic Inbox beta launch on Product Hunt (72 days ago)'],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: ['8 design partners signed on at beta launch'],
    hook_candidates: [
      {
        hook: 'Mosaic launched beta on Product Hunt with 8 design partners',
        evidence: 'Mosaic Inbox, a unified support inbox built by ex-Lattice support lead Priya Iyer, launched its beta. Eight design partners signed on.',
        confidence: 0.74,
      },
    ],
  },
  'colegiosanandres.edu.co': {
    company_stage: 'enterprise',
    recent_news: [
      'Convenio Colegio San Andrés ↔ Universidad EAFIT (El Colombiano, 58 días)',
      '14 estudiantes con becas internacionales en 2025 (Semana)',
    ],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: ['Convenio EAFIT firmado', '14 becas internacionales 2025'],
    hook_candidates: [
      {
        hook: 'El Colombiano cubrió el convenio EAFIT — visibilidad pública del placement universitario',
        evidence: 'El convenio crea una ruta directa para graduados de Colegio San Andrés hacia los programas de Universidad EAFIT en Medellín.',
        confidence: 0.82,
      },
    ],
  },
  'andeanfactoring.co': {
    company_stage: 'growth',
    recent_news: [
      'Andean asegura línea Bancolombia COP 50B (La República, 120 días)',
    ],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: ['Expansión Eje Cafetero PYMES textiles + agroindustriales'],
    hook_candidates: [
      {
        hook: 'La República cubrió la línea Bancolombia COP 50B — expansión validada',
        evidence: 'La línea permitirá ampliar las operaciones de factoring de Andean Factoring hacia el Eje Cafetero, atendiendo PYMES textiles y agroindustriales.',
        confidence: 0.84,
      },
    ],
  },
  'careloophealth.com': {
    company_stage: 'series-b',
    recent_news: [
      'CareLoop closes $42M Series B (Fierce Healthcare, 185 days ago)',
      'Atrium Health partnership for 12 hospitals (Becker\'s, 8 days ago)',
    ],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: [
      'Series B $42M (General Catalyst + a16z Bio)',
      'Atrium Health 12-hospital rollout',
    ],
    hook_candidates: [
      {
        hook: 'Becker\'s covered Atrium partnership — fresh validated expansion signal',
        evidence: 'Atrium Health is rolling out CareLoop\'s post-acute coordination platform across 12 of its hospitals in North and South Carolina.',
        confidence: 0.9,
      },
    ],
  },
  'halocreative.co': {
    company_stage: 'growth',
    recent_news: [
      'Halo wins Trove from Mekanism (Adweek, 12 days ago)',
    ],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: ['Trove Insurance account win'],
    hook_candidates: [
      {
        hook: 'Adweek covered Halo winning Trove from Mekanism',
        evidence: 'San Francisco brand-and-paid agency Halo Creative has won the Trove Insurance account from incumbent Mekanism following a competitive review.',
        confidence: 0.83,
      },
    ],
  },
  'wallacesteel.com': {
    company_stage: 'enterprise',
    recent_news: [],
    pain_signals: [],
    hiring_signals: [],
    growth_signals: [],
    hook_candidates: [],
  },
}

export function mockExtractNewsSignals(input: {
  domainHint?: string
}): ExtractedNewsSignals {
  const key = input.domainHint?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0] ?? ''
  return MOCK_NEWS_SIGNALS[key] ?? EMPTY_SIGNALS
}

// ─── Profiler (Sprint 6b) — Synthesis mock ──────────────────────────

/**
 * Curated synthesis dossiers keyed by company domain. Each dossier
 * represents the IDEAL output when all 3 sources contribute. When fewer
 * sources are available (partial enrichment), mockSynthesizeDossier
 * filters hook_candidates to those whose sourceName is in the available
 * set and scales the confidence_score down.
 *
 * Dedupe is baked into the curated dossiers: e.g. pulseanalytics.io has
 * ONE Series A hook (sourceName='news', the dedup winner) even though
 * all 3 sources mention the Series A. The evidence string concatenates
 * quotes from each source with " | " to demonstrate the dedup pattern
 * tests assert against.
 */
const MOCK_SYNTHESIS_DOSSIERS: Record<string, Omit<SynthesizedDossierJson, 'confidence_score'> & { confidence_score: number }> = {
  'pulseanalytics.io': {
    hook_candidates: [
      {
        hook: 'Pulse just closed $14M Series A with Costanoa — outbound motion in active build',
        evidence:
          '[news] TechCrunch July 2025: Pulse Analytics raises $14M Series A | [linkedin] Sarah Chen post 3 days ago: We just closed our $14M Series A | [company_website] News section: Pulse Analytics raises $14M Series A',
        sourceName: 'news',
        confidence: 0.93,
      },
      {
        hook: 'Pulse hiring Founding AE in SF — fresh GTM build, no incumbent to displace',
        evidence:
          '[company_website] We are hiring: Founding Account Executive (US) | [linkedin] Hiring our Founding AE in SF — DM me if you want to build the GTM motion from scratch',
        sourceName: 'company_website',
        confidence: 0.88,
      },
      {
        hook: 'Sarah speaking at SaaStr next month on activation metrics — public POV to reference',
        evidence:
          '[linkedin] Speaking at SaaStr next month on the difference between activation metrics that move retention vs the ones that just look good in board decks.',
        sourceName: 'linkedin',
        confidence: 0.78,
      },
    ],
    recommended_angle:
      'Lead with the TechCrunch Series A coverage from July 2025 and tie to her Founding AE hire — she is building GTM motion right now.',
    pain_inferred:
      'Sarah just raised Series A and is hiring her first Founding AE. The window for tools that accelerate outbound is open right now, before her org builds its own internal motion.',
    confidence_score: 0.88,
  },
  'careloophealth.com': {
    hook_candidates: [
      {
        hook: 'Atrium partnership rolling out across 12 hospitals — Rebecca actively scaling commercial team',
        evidence:
          '[news] Becker\'s 8 days ago: Atrium Health rolling out CareLoop across 12 hospitals | [linkedin] Rebecca: CareLoop just signed Atrium Health — 12 hospitals across the Carolinas | [company_website] February 2026: Partnership with Atrium Health, expanding to 12 hospitals in the Carolinas',
        sourceName: 'news',
        confidence: 0.92,
      },
      {
        hook: 'CareLoop hiring VP Sales + 2 enterprise AEs + clinical implementation lead',
        evidence:
          '[company_website] Currently hiring: VP of Sales (Atlanta or remote), Enterprise Account Executive, Clinical Implementation Manager | [linkedin] Hiring 2 enterprise AEs and a clinical implementation lead',
        sourceName: 'company_website',
        confidence: 0.9,
      },
    ],
    recommended_angle:
      'Open with the Becker\'s coverage of the Atrium rollout (8 days fresh) — Rebecca is mid-execution and the rollout is the active project on her plate.',
    pain_inferred:
      'CareLoop is rolling out 12 hospitals in the Carolinas via Atrium right now, while simultaneously hiring 3 senior commercial roles. The org is scaling faster than commercial process can keep up.',
    confidence_score: 0.91,
  },
  'colegiosanandres.edu.co': {
    hook_candidates: [
      {
        hook: 'Convenio EAFIT acaba de salir — Laura puede necesitar tooling de placement universitario',
        evidence:
          '[news] El Colombiano: Convenio Colegio San Andrés ↔ Universidad EAFIT | [linkedin] Laura: Orgullosa de anunciar el convenio entre Colegio San Andrés y Universidad EAFIT | [company_website] Marzo 2026: el colegio firma convenio con Universidad EAFIT',
        sourceName: 'news',
        confidence: 0.85,
      },
    ],
    recommended_angle:
      'Cita el convenio EAFIT que El Colombiano cubrió hace 58 días — es la noticia institucional reciente que Laura está promocionando activamente.',
    pain_inferred:
      'El colegio acaba de firmar el convenio EAFIT como diferencial de preparación universitaria. Necesitan herramientas para tracking de placement de egresados.',
    confidence_score: 0.79,
  },
  // Wallace Steel — explicit empty synthesis. Keeps the signal-sparse
  // graceful-degradation tests honest: dossier completes successfully
  // with empty hooks, no pain inferred, and confidence_score=0 (vs
  // falling through to the unknown-domain fallback's 0.3-0.4 default).
  'wallacesteel.com': {
    hook_candidates: [],
    recommended_angle: 'No outreach angle surfaced — dossier is thin.',
    pain_inferred: '',
    confidence_score: 0,
  },
}

/**
 * Deterministic synthesis mock. Behavior:
 *   - 0 sources → throw (caller should detect & skip synthesis)
 *   - Domain matches a curated dossier → return it, filtered by
 *     availableSources, with confidence scaled per source count
 *   - Unknown domain → synthesize from input signals: top 5 hooks by
 *     confidence, low confidence baseline
 */
export function mockSynthesizeDossier(input: {
  domainHint?: string
  sourcesCount: 1 | 2 | 3
  availableSources: ProfilerSourceName[]
  /**
   * Optional raw signals for unknown-domain fallback. When the curated
   * dossier lookup misses, we synthesize from these directly.
   */
  rawSourceSignals?: Array<{
    sourceName: ProfilerSourceName
    signals: ExtractedCompanyWebsiteSignals
  }>
}): SynthesizedDossierJson {
  // sourcesCount is typed `1 | 2 | 3` at the boundary — type system prevents
  // 0 reaching here. availableSources guard catches programmer error where
  // sourcesCount and the array length disagree.
  if (input.availableSources.length === 0) {
    throw new Error(
      'SYNTHESIS_NO_SOURCES: cannot synthesize without any source extraction',
    )
  }

  const key = input.domainHint
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .split('/')[0] ?? ''

  const available = new Set(input.availableSources)
  const curated = MOCK_SYNTHESIS_DOSSIERS[key]

  if (curated) {
    // Filter to hooks whose primary source is available. Partial
    // enrichment surfaces fewer hooks (matches real synthesis behavior).
    const filteredHooks = curated.hook_candidates.filter((h) =>
      available.has(h.sourceName),
    )
    const adjustedConfidence =
      input.sourcesCount === 3
        ? curated.confidence_score
        : input.sourcesCount === 2
          ? Math.min(curated.confidence_score, 0.65)
          : Math.min(curated.confidence_score, 0.45)
    return {
      hook_candidates: filteredHooks,
      recommended_angle: curated.recommended_angle,
      pain_inferred: curated.pain_inferred,
      confidence_score: adjustedConfidence,
    }
  }

  // Fallback: unknown domain. Take top hooks across input source signals
  // (caller passes rawSourceSignals so we don't need to parse the user
  // prompt). No cross-source dedupe — empty curated means no overlap data.
  const allHooks = (input.rawSourceSignals ?? []).flatMap((s) =>
    s.signals.hook_candidates.map((h) => ({
      hook: h.hook,
      evidence: h.evidence,
      sourceName: s.sourceName,
      confidence: h.confidence,
    })),
  )
  const topHooks = allHooks.sort((a, b) => b.confidence - a.confidence).slice(0, 5)
  return {
    hook_candidates: topHooks,
    recommended_angle:
      topHooks.length > 0
        ? `Engage based on available signals (${input.availableSources.join(', ')}).`
        : 'No specific angle detected — manual review recommended.',
    pain_inferred:
      topHooks.length > 0
        ? 'No specific pain pattern detected across available sources.'
        : 'No signals surfaced — dossier is thin.',
    confidence_score:
      input.sourcesCount === 3 ? 0.4 : input.sourcesCount === 2 ? 0.3 : 0.2,
  }
}

// ─── Token estimates per Sprint 6b call (mock) ──────────────────────

/** LinkedIn extraction: profile + posts + ICP scaffolding ≈ 1800 in, 500 out. */
export const MOCK_LINKEDIN_TOKENS_IN = 1800
export const MOCK_LINKEDIN_TOKENS_OUT = 500

/** News extraction: articles list is more compact ≈ 1200 in, 400 out. */
export const MOCK_NEWS_TOKENS_IN = 1200
export const MOCK_NEWS_TOKENS_OUT = 400

/** Synthesis: 3 source extractions concatenated ≈ 2200 in, 600 out. */
export const MOCK_SYNTHESIS_TOKENS_IN = 2200
export const MOCK_SYNTHESIS_TOKENS_OUT = 600

/**
 * Latency hints — separate bands per call type so per-source observations
 * stay distinguishable in cost_events.
 */
export function mockLinkedinLatencyMs(hint: string): number {
  const charSum = [...hint].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 1600 + (charSum % 1400) // 1600-3000ms
}

export function mockNewsLatencyMs(hint: string): number {
  const charSum = [...hint].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 1200 + (charSum % 1100) // 1200-2300ms
}

export function mockSynthesisLatencyMs(hint: string): number {
  const charSum = [...hint].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 2000 + (charSum % 1500) // 2000-3500ms
}

export { MOCK_LINKEDIN_SIGNALS, MOCK_NEWS_SIGNALS, MOCK_SYNTHESIS_DOSSIERS }
