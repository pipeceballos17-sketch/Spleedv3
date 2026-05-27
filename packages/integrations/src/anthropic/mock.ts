import type {
  DeepResearchOutput,
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

// ─── Deep research (Sprint 7b — Phase 7) mock ───────────────────────

/**
 * Opus 4.7 token estimates for a deep-research session. Chosen so the
 * computed LLM cost lands at ~$0.42 (Opus rate $15/$75 per M):
 *   10000 in × $15/M + 3600 out × $75/M = $0.15 + $0.27 = $0.42
 */
export const MOCK_DEEP_RESEARCH_TOKENS_IN = 10_000
export const MOCK_DEEP_RESEARCH_TOKENS_OUT = 3_600

/** Anthropic native web tool unit costs (2026 pricing). */
export const WEB_SEARCH_COST_USD = 0.01
export const WEB_FETCH_COST_USD = 0.001

/** Mock tool-call counts for a typical deep-research session. */
export const MOCK_DEEP_RESEARCH_WEB_SEARCH_COUNT = 8
export const MOCK_DEEP_RESEARCH_WEB_FETCH_COUNT = 4
/** Apify LinkedIn scrape cost when the agent invokes the custom tool. */
export const MOCK_DEEP_RESEARCH_CUSTOM_TOOL_COST_USD = 0.1

/**
 * Empty-but-valid deep research output. Returned for domains without a
 * curated MOCK_DEEP_RESEARCH_DOSSIERS entry (Wallace-style sparse leads),
 * and as the Sprint 7b CP1 default until CP2 populates the curated map.
 * Cost metadata still recorded — a deep-research attempt that surfaces
 * nothing still burns Opus + web-search budget.
 */
const EMPTY_DEEP_RESEARCH_CATEGORY = { findings: [], summary: '' }

/**
 * Curated deep-research dossiers keyed by company domain, cross-coherent
 * with Sprint 6b MOCK_SYNTHESIS_DOSSIERS (e.g. pulseanalytics.io's
 * succession finding ties Brian Chen's CSO appointment to the Series A
 * already in the synthesis dossier — Phase 8 dedup merges all three
 * evidence quotes into one hook).
 *
 * Fixtures carry their own toolCalls so per-domain research intensity
 * varies realistically (Wallace's sparse 6-search / 2-fetch yields
 * nothing; the commercial-lender's 12-search / 6-fetch / Apify combo
 * mines SEC EDGAR + UCC). LLM tokens/cost + latency are layered uniformly
 * by mockResearchDeep (the Opus call size is similar regardless of yield).
 */
const MOCK_DEEP_RESEARCH_DOSSIERS: Record<
  string,
  Omit<DeepResearchOutput, 'tokensIn' | 'tokensOut' | 'llmCostUsd' | 'latencyMs'>
> = {
  // ─── 1. pulseanalytics.io — Sarah Chen, US SaaS Series A ──────────
  'pulseanalytics.io': {
    succession_signals: {
      findings: [
        {
          signal: 'Brian Chen (founder\'s brother) joined as Chief Strategy Officer 2 months ago, post Series A',
          evidence:
            'LinkedIn announcement: "Thrilled to join my sister Sarah at Pulse Analytics as CSO to scale what she started."',
          source_url: 'https://linkedin.com/in/brianchen-cso',
          confidence: 0.95,
        },
        {
          signal: 'Costanoa board observer seat added alongside Series A close',
          evidence: 'Crunchbase board section lists a new Costanoa Ventures observer as of July 2025.',
          source_url: 'https://crunchbase.com/organization/pulse-analytics',
          confidence: 0.8,
        },
      ],
      summary:
        'Strong succession signal: founder co-opted a family member as CSO immediately post-Series A, indicating deliberate strategic-continuity build-out.',
    },
    hiring_signals: {
      findings: [
        {
          signal: '5 GTM roles posted in the past 30 days (VP Sales, 3 AE, 1 SDR)',
          evidence: 'Pulse Analytics careers page lists 5 open commercial roles, all posted within 30 days.',
          source_url: 'https://pulseanalytics.io/careers',
          confidence: 0.9,
        },
      ],
      summary: 'Aggressive GTM hiring sprint — the org is building its first real sales team now.',
    },
    tech_stack_signals: {
      findings: [
        {
          signal: 'Migrating CRM from Pipedrive to Salesforce (inferred from VP Sales job description)',
          evidence:
            'VP Sales posting: "Lead our migration from Pipedrive to Salesforce and build the RevOps function from scratch."',
          source_url: 'https://pulseanalytics.io/careers/vp-sales',
          confidence: 0.85,
        },
      ],
      summary: 'CRM migration in flight — a window for adjacent tooling decisions before processes ossify.',
    },
    recent_activity_signals: {
      findings: [
        {
          signal: 'Sarah keynoted SaaStr 2025 on activation metrics',
          evidence: 'SaaStr 2025 agenda lists Sarah Chen keynote: "Activation metrics that actually move retention."',
          source_url: 'https://saastr.com/2025/agenda',
          confidence: 0.9,
        },
        {
          signal: "Podcast guest on Lenny's Newsletter 3 weeks ago",
          evidence: "Lenny's Podcast episode 218 features Sarah Chen on product-led growth analytics.",
          source_url: 'https://lennysnewsletter.com/podcast/218',
          confidence: 0.88,
        },
      ],
      summary: 'High public profile — Sarah is actively building thought leadership in the PLG analytics space.',
    },
    recommended_hooks: [
      {
        hook: "Tie Sarah's Series A to Brian's CSO appointment as evidence of a deliberate scaling playbook — reference both in the opener",
        evidence:
          '[deep_research] Brian Chen joined as CSO post-Series A | [news] TechCrunch $14M Series A July 2025 | [linkedin] Sarah Series A announcement post',
        sourceName: 'deep_research',
        confidence: 0.92,
      },
      {
        hook: 'Lead with the Pipedrive→Salesforce migration — RevOps build-out is the active pain and the timing window is now',
        evidence: '[deep_research] VP Sales JD: "Lead our migration from Pipedrive to Salesforce and build RevOps from scratch."',
        sourceName: 'deep_research',
        confidence: 0.87,
      },
    ],
    toolCalls: {
      webSearchCount: 8,
      webFetchCount: 4,
      customToolCalls: [{ name: 'scrape_linkedin_profile', provider: 'apify', costUsd: 0.1 }],
    },
  },

  // ─── 2. wallacesteel.com — Henry Wallace, sparse signal ───────────
  // Graceful partial: deep research ran (burned search budget) but found
  // nothing actionable. Phase 8 gets minimal lift; confidence stays low.
  'wallacesteel.com': {
    succession_signals: {
      findings: [],
      summary: 'No public succession signals. Family-owned, no regulatory filings, no LinkedIn officer activity.',
    },
    hiring_signals: {
      findings: [],
      summary: 'No public job postings found. Hiring likely handled via local/offline channels.',
    },
    tech_stack_signals: {
      findings: [],
      summary: 'No discernible technology footprint — thin website, no job descriptions revealing stack.',
    },
    recent_activity_signals: {
      findings: [],
      summary: 'No podcasts, conference appearances, or public commentary found for Henry Wallace.',
    },
    recommended_hooks: [],
    toolCalls: {
      // Exhaustive search, nothing actionable — no custom-tool spend.
      webSearchCount: 6,
      webFetchCount: 2,
      customToolCalls: [],
    },
  },

  // ─── 3. examplelender.com — commercial lending / factoring ────────
  // Tenant guidance assumed: "Prioritize SEC EDGAR, state registries, UCC filings."
  // Highest research intensity — heavy government-source mining.
  'examplelender.com': {
    succession_signals: {
      findings: [
        {
          signal: 'CEO Jorge Martinez (62) — son joined as VP Operations 6 months ago',
          evidence: 'SEC EDGAR 10-K Item 10: notes Daniel Martinez (VP Operations) and references "ongoing succession planning."',
          source_url: 'https://sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=example',
          confidence: 0.9,
        },
        {
          signal: 'Board added an independent director with M&A background (2025 proxy)',
          evidence: 'DEF 14A proxy: new independent director with private-equity M&A experience joined Q1 2025.',
          source_url: 'https://sec.gov/edgar/example-def14a',
          confidence: 0.78,
        },
      ],
      summary:
        'Active succession + governance signals in SEC filings — next-gen family member elevated, M&A-experienced director added. Potential transition window.',
    },
    hiring_signals: {
      findings: [
        {
          signal: 'Recent COO hire poached from a direct factoring competitor',
          evidence: 'LinkedIn: new COO previously SVP Operations at a rival factoring lender, started 2 months ago.',
          source_url: 'https://linkedin.com/in/example-coo',
          confidence: 0.85,
        },
      ],
      summary: 'Senior operational hire from a competitor signals scaling intent and operational maturation.',
    },
    tech_stack_signals: {
      findings: [
        {
          signal: 'Legacy Sageworks factoring platform; RFP issued for replacement',
          evidence: 'State procurement portal lists an active RFP for "factoring/lending origination platform replacement."',
          source_url: 'https://procurement.example-state.gov/rfp/2026-0412',
          confidence: 0.82,
        },
      ],
      summary: 'Legacy core-system replacement in active RFP — a rare buying-window signal for adjacent vendors.',
    },
    recent_activity_signals: {
      findings: [
        {
          signal: 'Jorge Martinez is a Commercial Finance Association (CFA) member, 2 recent podcast appearances',
          evidence: 'CFA member directory + 2 episodes of "Secured Lending Today" featuring Jorge Martinez in past quarter.',
          source_url: 'https://cfa.com/members/example',
          confidence: 0.8,
        },
      ],
      summary: 'Industry-association engagement + podcast presence — accessible via trade-channel warm intro.',
    },
    recommended_hooks: [
      {
        hook: 'Reference the active RFP for Sageworks replacement — the buying window is open and timing is everything in core-system swaps',
        evidence: '[deep_research] State procurement RFP: "factoring/lending origination platform replacement" (active)',
        sourceName: 'deep_research',
        confidence: 0.84,
      },
      {
        hook: "Acknowledge the succession-planning language in their 10-K and Daniel's elevation — shows you did the homework on a family-business transition",
        evidence: '[deep_research] SEC EDGAR 10-K Item 10: Daniel Martinez VP Operations + "ongoing succession planning"',
        sourceName: 'deep_research',
        confidence: 0.86,
      },
    ],
    toolCalls: {
      webSearchCount: 12,
      webFetchCount: 6,
      customToolCalls: [{ name: 'scrape_linkedin_profile', provider: 'apify', costUsd: 0.1 }],
    },
  },

  // ─── 4. colegiosanandres.edu.co — escuela bilingüe Colombia ───────
  // Tenant guidance assumed: "MEN Colombia, ICFES, registros mercantiles,
  // ASPAEN/UNCOLI, El Tiempo/Semana."
  'colegiosanandres.edu.co': {
    succession_signals: {
      findings: [
        {
          signal: 'Family ownership (Pérez family, 3 generations); Laura Pérez heir apparent for rectory',
          evidence:
            'Registro mercantil lists Pérez family as owners since 1962; Laura Pérez (Directora Académica) widely positioned as next rector.',
          source_url: 'https://rues.org.co/example-colegio-san-andres',
          confidence: 0.88,
        },
      ],
      summary:
        'Multi-generational family institution with a clear heir apparent (Laura Pérez). Decision-making concentrates in the family.',
    },
    hiring_signals: {
      findings: [
        {
          signal: '2 senior teaching roles posted (IB Coordinator + Math Department Head)',
          evidence: 'Colegio careers + ASPAEN job board list IB Coordinator and Math Head openings.',
          source_url: 'https://colegiosanandres.edu.co/empleo',
          confidence: 0.83,
        },
      ],
      summary: 'Senior academic hiring suggests International Baccalaureate program expansion.',
    },
    tech_stack_signals: {
      findings: [
        {
          signal: 'Legacy Phidias school-management system; IT director hinting at migration',
          evidence: 'IT director LinkedIn post: "Evaluating modern alternatives to our current SIS — recommendations welcome."',
          source_url: 'https://linkedin.com/in/example-it-director',
          confidence: 0.75,
        },
      ],
      summary: 'School-information-system migration under consideration — adjacent edtech buying window.',
    },
    recent_activity_signals: {
      findings: [
        {
          signal: 'ASPAEN member; El Tiempo coverage on bilingual education; ICFES 2025 top-10 Colombia',
          evidence: 'El Tiempo feature on bilingual schools cites Colegio San Andrés; ICFES 2025 results rank it top 10 nationally.',
          source_url: 'https://eltiempo.com/educacion/colegios-bilingues-2026',
          confidence: 0.85,
        },
      ],
      summary: 'Strong public academic reputation + association membership — credibility-driven outreach lands well.',
    },
    recommended_hooks: [
      {
        hook: "Recognize Laura Pérez as the next-generation academic leader and the ICFES 2025 top-10 result — flatter the institutional legacy + recent win",
        evidence:
          '[deep_research] Registro mercantil 3-gen Pérez ownership + Laura heir apparent | [deep_research] ICFES 2025 top-10 | [linkedin] Laura Directora Académica',
        sourceName: 'deep_research',
        confidence: 0.85,
      },
      {
        hook: 'Lead with the SIS migration the IT director is exploring — concrete, current, and adjacent to any edtech offering',
        evidence: '[deep_research] IT director LinkedIn: "Evaluating modern alternatives to our current SIS."',
        sourceName: 'deep_research',
        confidence: 0.74,
      },
    ],
    toolCalls: {
      webSearchCount: 10,
      webFetchCount: 5,
      customToolCalls: [{ name: 'scrape_linkedin_profile', provider: 'apify', costUsd: 0.1 }],
    },
  },

  // ─── 5. exemplofintech.com.br — Brazilian fintech (cross-LatAm) ───
  'exemplofintech.com.br': {
    succession_signals: {
      findings: [
        {
          signal: 'Founder-CEO Mariana Silva (39); no clear succession signal',
          evidence: 'No regulatory or LinkedIn evidence of succession planning — early-stage founder-led.',
          source_url: 'https://linkedin.com/in/mariana-silva-fintech',
          confidence: 0.6,
        },
      ],
      summary: 'Founder firmly at the helm; no succession dynamics. Decision-making is direct.',
    },
    hiring_signals: {
      findings: [
        {
          signal: 'Series B raised; 10 engineering hires in past 60 days',
          evidence: 'LinkedIn + careers page show 10 new engineers joined in 60 days post Series B.',
          source_url: 'https://exemplofintech.com.br/carreiras',
          confidence: 0.9,
        },
      ],
      summary: 'Aggressive engineering scale-up post Series B — building product velocity.',
    },
    tech_stack_signals: {
      findings: [
        {
          signal: 'Microservices on AWS; hiring Site Reliability Engineers (mature-infra signal)',
          evidence: 'SRE job descriptions reference Kubernetes, Terraform, and a microservices migration on AWS.',
          source_url: 'https://exemplofintech.com.br/carreiras/sre',
          confidence: 0.82,
        },
      ],
      summary: 'Infra maturity signal — investing in reliability engineering, past the MVP-hacking phase.',
    },
    recent_activity_signals: {
      findings: [
        {
          signal: 'Mariana on a Brazilian fintech podcast; Forbes Brasil 30 Under 30; speaks at LatAm tech conferences',
          evidence: 'Forbes Brasil 30 Under 30 2025 list + podcast "Fintechs do Brasil" episode + LatAm conf speaker bio.',
          source_url: 'https://forbes.com.br/30under30/2025',
          confidence: 0.87,
        },
      ],
      summary: 'High-visibility founder across LatAm fintech media — warm-channel access via conference circuit.',
    },
    recommended_hooks: [
      {
        hook: "Congratulate the Series B and reference Mariana's Forbes Brasil 30 Under 30 — momentum + recognition in one opener",
        evidence: '[deep_research] Series B + 10 eng hires | [deep_research] Forbes Brasil 30 Under 30 2025',
        sourceName: 'deep_research',
        confidence: 0.86,
      },
      {
        hook: 'Note their SRE hiring as proof of infra maturity — position any tooling as fitting a team that already invests in reliability',
        evidence: '[deep_research] SRE JDs: Kubernetes + Terraform + microservices on AWS',
        sourceName: 'deep_research',
        confidence: 0.8,
      },
    ],
    toolCalls: {
      webSearchCount: 9,
      webFetchCount: 4,
      customToolCalls: [{ name: 'scrape_linkedin_profile', provider: 'apify', costUsd: 0.1 }],
    },
  },
}

/**
 * Deterministic deep-research mock. Looks curated dossier up by domain;
 * unknown domains get empty signal categories (graceful — Profiler still
 * proceeds to Phase 8 with thin deep research). Cost metadata is computed
 * with the Opus rate regardless of the client's configured model, since
 * deep research always runs on Opus 4.7.
 */
export function mockResearchDeep(input: {
  domainHint?: string
}): DeepResearchOutput {
  const key = input.domainHint
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .split('/')[0] ?? ''
  const curated = MOCK_DEEP_RESEARCH_DOSSIERS[key]

  const tokensIn = MOCK_DEEP_RESEARCH_TOKENS_IN
  const tokensOut = MOCK_DEEP_RESEARCH_TOKENS_OUT
  // Opus 4.7 rate ($15 input / $75 output per 1M) — deep research is
  // always Opus regardless of the AnthropicClient's default model.
  const llmCostUsd = (tokensIn / 1_000_000) * 15 + (tokensOut / 1_000_000) * 75

  const latencyHint = key || `len-${input.domainHint?.length ?? 0}`
  const charSum = [...latencyHint].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  const latencyMs = 8000 + (charSum % 7000) // 8-15s — deep research is slow

  if (!curated) {
    return {
      succession_signals: { ...EMPTY_DEEP_RESEARCH_CATEGORY },
      hiring_signals: { ...EMPTY_DEEP_RESEARCH_CATEGORY },
      tech_stack_signals: { ...EMPTY_DEEP_RESEARCH_CATEGORY },
      recent_activity_signals: { ...EMPTY_DEEP_RESEARCH_CATEGORY },
      recommended_hooks: [],
      tokensIn,
      tokensOut,
      llmCostUsd,
      toolCalls: {
        // Even an empty result burns search budget — the agent looked,
        // found nothing actionable. No custom-tool spend on a dead lead.
        webSearchCount: MOCK_DEEP_RESEARCH_WEB_SEARCH_COUNT,
        webFetchCount: MOCK_DEEP_RESEARCH_WEB_FETCH_COUNT,
        customToolCalls: [],
      },
      latencyMs,
    }
  }

  // Curated fixtures carry their own per-domain toolCalls (research
  // intensity varies — Wallace 6/2/none vs lender 12/6/Apify). LLM
  // tokens/cost + latency are layered uniformly.
  return {
    ...curated,
    tokensIn,
    tokensOut,
    llmCostUsd,
    latencyMs,
  }
}

export { MOCK_DEEP_RESEARCH_DOSSIERS }

// ─── Final synthesis (Sprint 7b — Phase 8) mock ─────────────────────

/**
 * Sonnet 4.6 token estimate for the final synthesis. Higher than Phase 6
 * (MOCK_SYNTHESIS_TOKENS) because the prompt now carries the deep research
 * dossier on top of the 3 initial sources.
 */
export const MOCK_SYNTHESIS_FINAL_TOKENS_IN = 3200
export const MOCK_SYNTHESIS_FINAL_TOKENS_OUT = 700

export function mockSynthesisFinalLatencyMs(hint: string): number {
  const charSum = [...hint].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return 2400 + (charSum % 1600) // 2400-4000ms
}

/**
 * Deterministic final-synthesis mock. Merges the curated Phase 6 synthesis
 * hooks (MOCK_SYNTHESIS_DOSSIERS) with the deep research recommended_hooks
 * (MOCK_DEEP_RESEARCH_DOSSIERS), dedupes, takes top 5. Confidence calibration:
 *
 *   - deep research HAS findings:
 *       3 initial sources → ceiling 0.92 (can reach 0.95 with strong signals)
 *       2 initial sources → ceiling 0.82
 *       1 initial source  → ceiling 0.72
 *   - deep research EMPTY (Wallace): final confidence stays capped at 0.50
 *     regardless of nominal source count — research that found nothing
 *     adds no lift.
 *
 * Final confidence never drops below the initial Phase 6 confidence (the
 * final synthesis only adds information).
 */
export function mockSynthesizeFinal(input: {
  domainHint?: string
  sourcesCount: 1 | 2 | 3
  deepResearchHasFindings: boolean
  initialConfidence: number
}): SynthesizedDossierJson {
  const key = input.domainHint
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .split('/')[0] ?? ''

  const synthesisCurated = MOCK_SYNTHESIS_DOSSIERS[key]
  const deepCurated = MOCK_DEEP_RESEARCH_DOSSIERS[key]

  // Deep research hooks lead (richer, integrate initial signals), then fill
  // remaining slots with Phase 6 hooks whose core fact isn't already covered.
  const deepHooks = (deepCurated?.recommended_hooks ?? []).map((h) => ({
    hook: h.hook,
    evidence: h.evidence,
    sourceName: 'deep_research' as const,
    confidence: h.confidence,
  }))
  const initialHooks = synthesisCurated?.hook_candidates ?? []
  // Crude dedupe: skip an initial hook if a deep hook already mentions its
  // first 4 significant words (catches "Series A" overlap etc).
  const deepHaystack = deepHooks.map((h) => h.hook.toLowerCase()).join(' | ')
  const dedupedInitial = initialHooks.filter((h) => {
    const key4 = h.hook.toLowerCase().split(/\s+/).slice(0, 4).join(' ')
    return !deepHaystack.includes(key4)
  })
  const mergedHooks = [...deepHooks, ...dedupedInitial].slice(0, 5)

  // Confidence calibration. "4 sources" = 3 initial + deep research (which
  // only runs in Phase 8 when it succeeded). Ceilings track the prompt:
  // 4 sources → 0.95, 3 sources → 0.85, 2 sources → 0.75.
  let confidence: number
  if (input.deepResearchHasFindings) {
    const ceiling =
      input.sourcesCount === 3 ? 0.95 : input.sourcesCount === 2 ? 0.85 : 0.75
    confidence = Math.min(0.95, Math.max(input.initialConfidence, ceiling))
  } else {
    // Empty deep research — no lift. "We looked and found nothing" caps
    // confidence at 0.50 (a thin-dossier ceiling). Never adds a bump: a
    // zero-signal lead (Wallace, initial 0) stays at 0.
    confidence = Math.min(0.5, input.initialConfidence)
  }

  const recommendedAngle =
    deepHooks.length > 0
      ? (deepHooks[0]!.hook)
      : (synthesisCurated?.recommended_angle ?? 'Engage based on available signals.')

  // Pain: prefer deep-research-derived succession/hiring/tech narrative when
  // present; else fall back to the Phase 6 synthesis pain.
  const painInferred =
    input.deepResearchHasFindings && deepCurated
      ? `${synthesisCurated?.pain_inferred ?? ''} Deep research adds: ${deepCurated.succession_signals.summary || deepCurated.hiring_signals.summary || deepCurated.tech_stack_signals.summary}`.trim()
      : (synthesisCurated?.pain_inferred ?? 'No specific pain pattern detected.')

  return {
    hook_candidates: mergedHooks,
    recommended_angle: recommendedAngle,
    pain_inferred: painInferred,
    confidence_score: Number(confidence.toFixed(2)),
  }
}
