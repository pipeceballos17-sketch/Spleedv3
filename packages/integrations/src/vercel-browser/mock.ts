/**
 * Vercel agent-browser mock fixtures — 7 companies whose domains align
 * with Apollo mock candidates (mock_01, mock_03, mock_04, mock_06, mock_08,
 * mock_10, mock_12). This lets end-to-end Sprint 6a tests run Scout →
 * Profiler against the same identities seen in Sprint 5a Scout tests.
 *
 * pageContent is deliberately hand-curated to embed extractable signals:
 *   - growth_signals (revenue, customer, hiring scale phrases)
 *   - hiring_signals (open roles, recent hires)
 *   - pain_signals (problem statements in About/blog copy)
 *   - recent_news (dates, announcements)
 *
 * The companion anthropic mock (anthropic/mock.ts → mockExtractCompanyWebsiteSignals)
 * is curated against these same domains. They must stay logically aligned —
 * if you add a domain here, also add curated extraction signals there.
 *
 * Variety dimensions:
 *   - Industries: saas, fintech, education, healthcare, manufacturing, marketing
 *   - Geo: US (SF/NYC/Austin/Boston/Chicago), LatAm (Bogotá/Medellín)
 *   - Stage: pre-seed solo founder, seed, Series A, Series B, legacy enterprise
 *   - Signal density: ranges from rich (pulseanalytics) to sparse (wallacesteel)
 */

import type {
  AnnotatedScreenshotResult,
  CompanyWebsiteScrapeResult,
  GoogleNewsScrapeResult,
  NewsArticle,
  TakeAnnotatedScreenshotInput,
} from './types'

const COST_PER_SCRAPE_USD = 0.003
const COST_PER_NEWS_SCRAPE_USD = 0.002
const COST_PER_SCREENSHOT_USD = 0.001
const CREDITS_PER_SCRAPE = 1

/**
 * Stable reference epoch — matches Apify mock (2026-05-15T12:00:00Z).
 * Aligning the two mocks lets a single test reason about relative dates
 * across LinkedIn posts and news articles without drift between runs.
 */
const REFERENCE_NOW = new Date('2026-05-15T12:00:00Z').getTime()
function daysAgoIso(days: number): string {
  return new Date(REFERENCE_NOW - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Domain → curated scrape result. Lookups normalize to lowercase. Unknown
 * domains fall back to a synthesized "thin website" result (see synthesizeUnknownDomain).
 */
const MOCK_COMPANY_WEBSITES: Record<string, CompanyWebsiteScrapeResult> = {
  // Strong-signal SaaS US (mock_01 Sarah Chen, Series A scaling)
  'pulseanalytics.io': {
    pageContent: {
      title: 'Pulse Analytics — Real-time customer behavior data for B2B SaaS',
      mainText:
        'Pulse Analytics gives B2B SaaS teams real-time visibility into how their customers actually use the product. Trusted by 240+ scaling startups. We replace the cobbled-together stack of Mixpanel, Heap, and custom warehouses with a single API and dashboard purpose-built for product-led growth teams. Customers reduce churn by 18% in the first quarter.',
      aboutText:
        'Founded in 2024 by Sarah Chen (ex-Segment) after watching dozens of seed-stage founders burn months stitching analytics together instead of shipping. Series A led by Costanoa Ventures, July 2025. Team of 12 across San Francisco and remote.',
      teamText:
        'We are hiring: Senior Product Engineer, Founding Account Executive (US), Customer Success Lead. We move fast and we ship to production every day.',
      newsText:
        'Pulse Analytics raises $14M Series A (July 2025) — Costanoa Ventures leads round. Pulse joins Y Combinator alumni demo. New integration with Stripe Billing announced Q2 2026. Hiring spree: 6 roles open including Founding AE.',
    },
    metadata: {
      finalUrl: 'https://pulseanalytics.io/',
      statusCode: 200,
      loadTimeMs: 1840,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },

  // Small SaaS founder-led (mock_03 Priya Iyer, seed-stage)
  'mosaicinbox.com': {
    pageContent: {
      title: 'Mosaic Inbox — One inbox for every customer conversation',
      mainText:
        'Mosaic consolidates email, Slack, and Intercom threads into a single inbox so founder-led support teams stop dropping context. Built for early-stage SaaS where the founder still handles half the tickets. Free for teams under 5. We are pre-revenue and shipping with our first 8 design partners.',
      aboutText:
        'Mosaic was started in early 2026 by Priya Iyer to scratch her own itch running support for a previous startup. Bootstrapped, 6 people, New York based. We talk to every customer ourselves.',
      teamText:
        'Two engineers, one designer, three on customer work (including Priya). We have not raised external capital.',
      newsText: 'Mosaic launched its beta in March 2026. First paid customer signed last week.',
    },
    metadata: {
      finalUrl: 'https://mosaicinbox.com/',
      statusCode: 200,
      loadTimeMs: 1210,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },

  // Education Colombia (mock_06 Laura Pérez, established institution)
  'colegiosanandres.edu.co': {
    pageContent: {
      title: 'Colegio San Andrés — Educación bilingüe Medellín desde 1962',
      mainText:
        'Colegio San Andrés es un colegio bilingüe privado en Medellín, Colombia. 120 docentes, más de 1,400 estudiantes desde preescolar hasta media vocacional. Acreditación ICFES nivel A+. Programa de preparación universitaria con resultados destacados en los últimos cinco años.',
      aboutText:
        'Fundado en 1962 por la familia Pérez. La actual Directora Académica, Laura Pérez, asumió el cargo en 2022 tras una década dirigiendo el departamento de inglés.',
      newsText:
        'Marzo 2026: el colegio firma convenio con Universidad EAFIT para articulación de programas. Octubre 2025: renovación de acreditación ICFES por cinco años más. Estudiantes graduados con becas internacionales en 2025: 14.',
    },
    metadata: {
      finalUrl: 'https://colegiosanandres.edu.co/',
      statusCode: 200,
      loadTimeMs: 2150,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },

  // Fintech traditional Colombia (mock_04 Diego Restrepo, low digital signal)
  'andeanfactoring.co': {
    pageContent: {
      title: 'Andean Factoring — Capital de trabajo para PYMES',
      mainText:
        'Andean Factoring ofrece soluciones de factoring y descuento de facturas para pequeñas y medianas empresas en Colombia. 18 años en el mercado, oficinas en Bogotá, Medellín y Cali. Equipo de 45 personas. Atendemos sectores: textil, agroindustria, manufactura ligera.',
      aboutText:
        'Andean Factoring fue fundada por Diego Restrepo en 2008. La compañía mantiene calificación de riesgo BRC1+ desde 2019.',
      newsText:
        'Enero 2026: Andean firma línea de crédito con Bancolombia por COP 50 mil millones para ampliar operaciones en el Eje Cafetero.',
      // Sprint 9 — contact line published on the website (curated). Exercises
      // the company-website phone extraction source.
      contactPhone: '+57 1 555 1234',
    },
    metadata: {
      finalUrl: 'https://andeanfactoring.co/',
      statusCode: 200,
      loadTimeMs: 1980,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },

  // Healthcare US (mock_08 Rebecca Lin, Series B growth)
  'careloophealth.com': {
    pageContent: {
      title: 'CareLoop Health — Closing the gap between hospital discharge and home',
      mainText:
        'CareLoop coordinates post-acute care for patients leaving the hospital. We work with 38 health systems across the US to reduce 30-day readmissions through automated check-ins, medication reconciliation, and rapid triage. Our partners have seen readmission rates drop by 22% on average.',
      aboutText:
        'CareLoop was founded in 2022 in Boston by clinicians and operators from Mass General. We closed our Series B in late 2025 led by General Catalyst, with participation from a16z Bio.',
      teamText:
        'Currently hiring: VP of Sales (Atlanta or remote), Enterprise Account Executive, Clinical Implementation Manager. Team of 180 across Boston HQ and remote field clinicians.',
      newsText:
        'November 2025: CareLoop closes $42M Series B. February 2026: CareLoop launches new partnership with Atrium Health, expanding to 12 hospitals in the Carolinas.',
    },
    metadata: {
      finalUrl: 'https://careloophealth.com/',
      statusCode: 200,
      loadTimeMs: 1620,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },

  // Manufacturing legacy (mock_10 Henry Wallace, thin web presence)
  'wallacesteel.com': {
    pageContent: {
      title: 'Wallace Steel Co.',
      mainText:
        'Wallace Steel Co. has been producing structural steel for commercial construction in the Pittsburgh region since 1968. Family-owned. ASTM A992 compliant.',
      aboutText: 'Three generations. 240 employees across the Pittsburgh and Youngstown plants.',
    },
    metadata: {
      finalUrl: 'https://wallacesteel.com/',
      statusCode: 200,
      loadTimeMs: 980,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },

  // Marketing US (mock_12 Jasmine Park, growth-stage agency)
  'halocreative.co': {
    pageContent: {
      title: 'Halo Creative — Brand-led growth marketing for consumer startups',
      mainText:
        'Halo Creative is a 60-person growth marketing agency working with 22 funded consumer brands. We combine brand strategy with paid acquisition. Founded 2019 in San Francisco. Clients include Public Pharmacy, Mira Goods, and Trove Insurance.',
      aboutText:
        'Halo was started by Jasmine Park after 8 years inside Wieden+Kennedy. Our team blends brand creatives with quantitative paid media operators — most agencies pick one side. We work mostly with Series A-C consumer brands.',
      teamText:
        'Hiring: Senior Paid Social Lead, Brand Strategist, Director of Client Services. 60 people across SF and NYC offices.',
      newsText:
        'February 2026: Halo announces $1.5M ARR milestone after 12-month doubling. March 2026: Halo wins Trove Insurance account from incumbent Mekanism.',
    },
    metadata: {
      finalUrl: 'https://halocreative.co/',
      statusCode: 200,
      loadTimeMs: 1450,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  },
}

/**
 * Lookup a mock scrape result by domain (case-insensitive). Returns null for
 * unknown domains so the caller can synthesize a graceful empty result.
 */
export function mockScrapeCompanyWebsite(domain: string): CompanyWebsiteScrapeResult | null {
  const key = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0] ?? ''
  return MOCK_COMPANY_WEBSITES[key] ?? null
}

/**
 * Fallback for unknown domains: emit a deterministic thin scrape result so
 * downstream extraction has something to work with (and degrades gracefully
 * to empty signals when the website carries no extractable info).
 */
export function synthesizeUnknownDomain(domain: string): CompanyWebsiteScrapeResult {
  return {
    pageContent: {
      title: domain,
      mainText: `No mock content registered for ${domain}. Live mode would scrape the real website.`,
    },
    metadata: {
      finalUrl: domain.startsWith('http') ? domain : `https://${domain}/`,
      statusCode: 200,
      loadTimeMs: 800,
    },
    creditsConsumed: CREDITS_PER_SCRAPE,
    costUsd: COST_PER_SCRAPE_USD,
  }
}

export { MOCK_COMPANY_WEBSITES, COST_PER_SCRAPE_USD, CREDITS_PER_SCRAPE }

// ─── Sprint 6b — Google News mock articles per company ─────────────

/**
 * Curated news articles keyed by company domain. Aligned with the
 * pageContent fixtures above and the LinkedIn posts in @spleed/integrations
 * /apify/mock.ts so a single profiling run produces a coherent cross-source
 * narrative (e.g. Sarah Chen's Series A appears in company website news +
 * LinkedIn post + TechCrunch article — synthesis should dedupe to 1 hook).
 *
 * Mock matches normalize lowercase domain (handles both "pulseanalytics.io"
 * and "https://pulseanalytics.io/" inputs).
 */
const MOCK_NEWS_ARTICLES: Record<string, NewsArticle[]> = {
  'pulseanalytics.io': [
    {
      title: 'Pulse Analytics raises $14M Series A led by Costanoa Ventures',
      url: 'https://techcrunch.com/2025/07/pulse-analytics-series-a',
      source: 'TechCrunch',
      publishedAt: daysAgoIso(310), // ~July 2025 vs ref May 2026
      snippet:
        'The B2B product analytics startup founded by ex-Segment PM Sarah Chen closed a $14M Series A led by Costanoa Ventures, with participation from Y Combinator and angel investors from Stripe and Notion.',
      relevanceScore: 0.94,
    },
    {
      title: 'Why product analytics needs a rethink for B2B SaaS, per Pulse founder',
      url: 'https://saastr.com/articles/pulse-analytics-founder-interview',
      source: 'SaaStr',
      publishedAt: daysAgoIso(35),
      snippet:
        'Sarah Chen sits down with SaaStr to discuss why the current product analytics stack — Mixpanel plus Heap plus a warehouse — fails for product-led growth teams.',
      relevanceScore: 0.81,
    },
  ],
  'mosaicinbox.com': [
    {
      title: 'Mosaic Inbox launches beta to unify support channels for early-stage startups',
      url: 'https://producthunt.com/posts/mosaic-inbox',
      source: 'Product Hunt',
      publishedAt: daysAgoIso(72),
      snippet:
        'Mosaic Inbox, a unified support inbox built by ex-Lattice support lead Priya Iyer, launched its beta. Eight design partners signed on.',
      relevanceScore: 0.78,
    },
  ],
  'colegiosanandres.edu.co': [
    {
      title: 'Colegio San Andrés firma convenio con Universidad EAFIT para articulación académica',
      url: 'https://elcolombiano.com/educacion/colegio-san-andres-eafit',
      source: 'El Colombiano',
      publishedAt: daysAgoIso(58),
      snippet:
        'El convenio crea una ruta directa para graduados de Colegio San Andrés hacia los programas de Universidad EAFIT en Medellín.',
      relevanceScore: 0.87,
    },
    {
      title: '14 estudiantes de Colegio San Andrés reciben becas internacionales en 2025',
      url: 'https://semana.com/educacion/becas-san-andres-2025',
      source: 'Semana',
      publishedAt: daysAgoIso(140),
      snippet:
        'Los estudiantes serán recibidos por universidades en Estados Unidos, Canadá, y España gracias al programa de preparación universitaria del colegio.',
      relevanceScore: 0.7,
    },
  ],
  'andeanfactoring.co': [
    {
      title: 'Andean Factoring asegura línea de crédito con Bancolombia por $50.000 millones',
      url: 'https://larepublica.co/finanzas/andean-factoring-bancolombia',
      source: 'La República',
      publishedAt: daysAgoIso(120),
      snippet:
        'La línea permitirá ampliar las operaciones de factoring de Andean Factoring hacia el Eje Cafetero, atendiendo PYMES textiles y agroindustriales.',
      relevanceScore: 0.86,
    },
  ],
  'careloophealth.com': [
    {
      title: 'CareLoop Health closes $42M Series B led by General Catalyst',
      url: 'https://fiercehealthcare.com/health-tech/careloop-series-b',
      source: 'Fierce Healthcare',
      publishedAt: daysAgoIso(185), // ~Nov 2025
      snippet:
        'CareLoop Health raised $42M Series B led by General Catalyst with participation from a16z Bio, bringing total funding to $58M.',
      relevanceScore: 0.91,
    },
    {
      title: 'Atrium Health partners with CareLoop to expand post-discharge care across the Carolinas',
      url: 'https://beckershospitalreview.com/healthcare/atrium-careloop-partnership',
      source: "Becker's Hospital Review",
      publishedAt: daysAgoIso(8),
      snippet:
        'Atrium Health is rolling out CareLoop\'s post-acute coordination platform across 12 of its hospitals in North and South Carolina.',
      relevanceScore: 0.89,
    },
  ],
  'halocreative.co': [
    {
      title: 'Halo Creative wins Trove Insurance account from Mekanism',
      url: 'https://adweek.com/agencyspy/halo-trove-win',
      source: 'Adweek',
      publishedAt: daysAgoIso(12),
      snippet:
        'San Francisco brand-and-paid agency Halo Creative has won the Trove Insurance account from incumbent Mekanism following a competitive review.',
      relevanceScore: 0.85,
    },
  ],
  // Wallace Steel: no news — graceful empty path
  'wallacesteel.com': [],
}

/**
 * Normalize a Google News query for mock lookup. Real Profiler passes
 * the full company name + domain; mock keys are bare domain strings.
 */
function normalizeNewsKey(query: string): string {
  const lower = query.toLowerCase()
  // Crude: search for any known domain substring in the query. Real Google
  // News parses the query itself; mock just needs deterministic mapping.
  for (const key of Object.keys(MOCK_NEWS_ARTICLES)) {
    if (lower.includes(key)) return key
  }
  // Fallback: strip non-alphanumerics, see if remaining matches.
  const stripped = lower.replace(/[^a-z0-9.]/g, '').replace(/^https?/, '')
  for (const key of Object.keys(MOCK_NEWS_ARTICLES)) {
    if (stripped.includes(key.replace('.', ''))) return key
  }
  return ''
}

/**
 * Mock Google News scrape. Filters by daysBack + maxResults like the real
 * agent-browser-driven scrape would.
 */
export function mockScrapeGoogleNews(
  query: string,
  options: { daysBack?: number; maxResults?: number } = {},
): GoogleNewsScrapeResult {
  const key = normalizeNewsKey(query)
  const all = MOCK_NEWS_ARTICLES[key] ?? []
  const daysBack = options.daysBack ?? 90
  const cutoff = REFERENCE_NOW - daysBack * 24 * 60 * 60 * 1000
  const filtered = all.filter((a) => new Date(a.publishedAt).getTime() >= cutoff)
  const maxResults = options.maxResults ?? 10
  const sliced = filtered.slice(0, maxResults)
  return {
    articles: sliced,
    metadata: {
      query,
      resultsCount: sliced.length,
      scrapedAt: new Date(REFERENCE_NOW).toISOString(),
    },
    costUsd: COST_PER_NEWS_SCRAPE_USD,
  }
}

// ─── Sprint 6b — Annotated screenshot mock ─────────────────────────

/**
 * 1×1 transparent PNG. 67 bytes total, minimum-valid file the agent-browser
 * would emit for a successful but uninteresting capture. Sprint 7+ live
 * mode replaces this with the actual screenshot from the agent-browser
 * session. Bytes are hand-verified valid PNG (IHDR + IDAT + IEND chunks).
 */
const ONE_BY_ONE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/**
 * Deterministic mock screenshot. Returns a tiny valid PNG so callers can
 * round-trip the bytes through Supabase Storage logic (size/mime checks)
 * without truly rendering a page. Cost recorded for cost_events parity.
 */
export function mockTakeAnnotatedScreenshot(
  _input: TakeAnnotatedScreenshotInput,
): AnnotatedScreenshotResult {
  return {
    imageBytes: ONE_BY_ONE_PNG,
    mimeType: 'image/png',
    costUsd: COST_PER_SCREENSHOT_USD,
  }
}

export {
  MOCK_NEWS_ARTICLES,
  COST_PER_NEWS_SCRAPE_USD,
  COST_PER_SCREENSHOT_USD,
  ONE_BY_ONE_PNG,
}
