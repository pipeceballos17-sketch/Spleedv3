/**
 * Apify mock fixtures — LinkedIn profile + posts curated per linkedin URL.
 *
 * URLs match the linkedinUrl values in @spleed/integrations/apollo/mock.ts
 * so Sprint 6b end-to-end tests can run Scout → Profiler against the same
 * identities. Each profile embeds extractable signals (recent role changes,
 * fundraise mentions, hiring posts) that the Anthropic mock extraction
 * curated MOCK_LINKEDIN_SIGNALS map can then "discover."
 *
 * Variety dimensions (mirror Vercel browser mock companies):
 *   - Industries: saas, fintech, education, healthcare, manufacturing, marketing
 *   - Career stage: solo founder → C-suite at growth co → director at legacy
 *   - Signal density: rich (Sarah Chen) to sparse (Henry Wallace)
 *
 * Lookups normalize to lowercase + strip trailing slash. Unknown profile
 * URLs fall through to synthesizeUnknownProfile / synthesizeEmptyPosts so
 * downstream extraction degrades to empty signals rather than failing.
 */

import { normalizeLinkedinUrl } from '@spleed/shared/normalize'
import type {
  ApifyLinkedinPostsScrapeResult,
  ApifyLinkedinProfileScrapeResult,
  LinkedinPost,
  LinkedinProfile,
} from './types'

const COST_PER_PROFILE_USD = 0.075
const COST_PER_POSTS_USD = 0.025

/**
 * Compute an ISO timestamp `daysAgo` days before a stable epoch. Using a
 * fixed reference (2026-05-15T12:00:00Z) keeps fixtures deterministic
 * across test runs — relative dates would drift the snapshot day-by-day.
 */
const REFERENCE_NOW = new Date('2026-05-15T12:00:00Z').getTime()
function daysAgoIso(days: number): string {
  return new Date(REFERENCE_NOW - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Convert any LinkedIn URL/handle shape to a bare-host lookup key for
 * MOCK_PROFILES / MOCK_POSTS. Routes through the canonical shared
 * normalizer (Sprint 7a single source of truth) then strips the
 * https://-prefix so keys stay `linkedin.com/in/<handle>` for compactness.
 *
 * Returns the empty string for non-LinkedIn input — internal sentinel
 * that misses every MOCK_PROFILES key, so callers fall through to
 * synthesizeUnknownProfile gracefully.
 */
function toBareLinkedinKey(url: string): string {
  const canonical = normalizeLinkedinUrl(url)
  if (!canonical) return ''
  return canonical.replace(/^https:\/\//, '')
}

// ─── Curated profiles ───────────────────────────────────────────────

const MOCK_PROFILES: Record<string, LinkedinProfile> = {
  // Sarah Chen — Series A SaaS founder (mock_01)
  'linkedin.com/in/sarahchen': {
    fullName: 'Sarah Chen',
    headline: 'Founder & CEO at Pulse Analytics | ex-Segment | building the product analytics layer for B2B SaaS',
    currentPosition: {
      title: 'Founder & CEO',
      company: 'Pulse Analytics',
      startDate: '2024-01',
      description:
        'Building real-time product analytics for B2B SaaS. Raised $14M Series A from Costanoa in July 2025. Hiring across engineering, GTM, and customer success.',
    },
    experience: [
      {
        title: 'Founder & CEO',
        company: 'Pulse Analytics',
        startDate: '2024-01',
        description: 'See current position.',
      },
      {
        title: 'Principal PM, Growth',
        company: 'Segment',
        startDate: '2020-03',
        endDate: '2023-12',
        description: "Led the product-led growth investment that took Segment's self-serve revenue from 8% → 31% of new ARR.",
      },
      {
        title: 'Senior PM',
        company: 'Stripe',
        startDate: '2018-06',
        endDate: '2020-02',
      },
    ],
    education: [
      { institution: 'Stanford University', degree: 'MS', field: 'Computer Science', years: '2016-2018' },
      { institution: 'UC Berkeley', degree: 'BS', field: 'EECS', years: '2012-2016' },
    ],
    skills: ['Product Strategy', 'Growth', 'Analytics', 'SQL', 'TypeScript', 'B2B SaaS', 'Fundraising'],
    about:
      "Founder of Pulse Analytics — real-time product analytics for B2B SaaS teams. We replace the Mixpanel + Heap + warehouse stack with one purpose-built tool. 240+ customers, $14M Series A (Costanoa, July 2025), hiring Founding AE in SF.",
    location: 'San Francisco Bay Area',
    connectionsCount: 2400,
  },

  // Priya Iyer — seed-stage solo-ish founder (mock_03)
  'linkedin.com/in/priyaiyer': {
    fullName: 'Priya Iyer',
    headline: 'Founder, Mosaic Inbox | unified support inbox for founder-led teams',
    currentPosition: {
      title: 'Founder',
      company: 'Mosaic Inbox',
      startDate: '2026-01',
      description: 'Launched beta March 2026. 8 design partners. First paid customer signed last week.',
    },
    experience: [
      { title: 'Founder', company: 'Mosaic Inbox', startDate: '2026-01' },
      {
        title: 'Head of Support',
        company: 'Lattice (prior startup)',
        startDate: '2022-09',
        endDate: '2025-12',
        description: 'Built support function from 0 → 14 people through Series C.',
      },
    ],
    education: [
      { institution: 'Cornell University', degree: 'BS', field: 'Operations Research', years: '2014-2018' },
    ],
    skills: ['Customer Support', 'B2B SaaS', 'Founder-Led Sales', 'Operations'],
    about: 'Founder-led sales is exhausting. I built Mosaic so the inbox stops dropping context across Slack, Email, and Intercom.',
    location: 'New York, NY',
    connectionsCount: 870,
  },

  // Laura Pérez — director, established institution (mock_06)
  'linkedin.com/in/lauraperezedu': {
    fullName: 'Laura Pérez',
    headline: 'Directora Académica · Colegio San Andrés · Medellín, Colombia',
    // Sprint 9 — contact phone surfaced via LinkedIn contact info (curated).
    phone: '+57 1 234 5678',
    currentPosition: {
      title: 'Directora Académica',
      company: 'Colegio San Andrés',
      startDate: '2022-08',
      description:
        'Liderazgo del programa académico y de preparación universitaria. Acreditación ICFES A+ renovada en 2025. Convenio recientemente firmado con Universidad EAFIT.',
    },
    experience: [
      { title: 'Directora Académica', company: 'Colegio San Andrés', startDate: '2022-08' },
      {
        title: 'Jefe de Área Inglés',
        company: 'Colegio San Andrés',
        startDate: '2012-01',
        endDate: '2022-07',
      },
    ],
    education: [
      { institution: 'Universidad EAFIT', degree: 'Maestría', field: 'Educación Bilingüe', years: '2018-2020' },
      { institution: 'Universidad de Antioquia', degree: 'Licenciatura', field: 'Lenguas Extranjeras', years: '2006-2010' },
    ],
    skills: ['Educación Bilingüe', 'Liderazgo Académico', 'ICFES', 'Curriculum Design'],
    about: 'Liderando la transformación académica de Colegio San Andrés tras una década en el aula. Foco en preparación universitaria internacional.',
    location: 'Medellín, Antioquia, Colombia',
    connectionsCount: 1200,
  },

  // Diego Restrepo — fintech traditional, low signal (mock_04)
  'linkedin.com/in/diegorestrepo': {
    fullName: 'Diego Restrepo',
    headline: 'CEO · Andean Factoring · Bogotá',
    // No LinkedIn phone for Diego — his number is published on the company
    // website instead (see andeanfactoring.co contactPhone), exercising the
    // company-website extraction source.
    currentPosition: {
      title: 'CEO',
      company: 'Andean Factoring',
      startDate: '2008-01',
      description: 'Fundador. 18 años operando, calificación BRC1+ desde 2019. Nueva línea con Bancolombia enero 2026 para Eje Cafetero.',
    },
    experience: [
      { title: 'CEO', company: 'Andean Factoring', startDate: '2008-01' },
      { title: 'Analista Senior', company: 'Bancolombia', startDate: '2002-03', endDate: '2007-12' },
    ],
    education: [
      { institution: 'Universidad de los Andes', degree: 'MBA', years: '2007-2008' },
      { institution: 'Pontificia Universidad Javeriana', degree: 'Economía', years: '1998-2002' },
    ],
    skills: ['Factoring', 'Crédito PYME', 'Análisis Riesgo'],
    location: 'Bogotá, Colombia',
    connectionsCount: 540,
  },

  // Rebecca Lin — Series B healthcare GTM (mock_08)
  'linkedin.com/in/rebeccalin': {
    fullName: 'Rebecca Lin',
    headline: 'VP Sales · CareLoop Health · scaling post-Series B distribution to health systems',
    currentPosition: {
      title: 'VP of Sales',
      company: 'CareLoop Health',
      startDate: '2025-08',
      description: 'Joined CareLoop a month before Series B close. Building out enterprise AE team across Atlanta and remote. Just signed Atrium Health (12 hospitals).',
    },
    experience: [
      { title: 'VP of Sales', company: 'CareLoop Health', startDate: '2025-08' },
      {
        title: 'Director of Sales',
        company: 'Olive AI',
        startDate: '2022-04',
        endDate: '2025-07',
        description: 'Closed 8 of top 25 IDNs as customer.',
      },
      { title: 'Enterprise AE', company: 'athenahealth', startDate: '2018-06', endDate: '2022-03' },
    ],
    education: [{ institution: 'Tufts University', degree: 'BA', field: 'Economics', years: '2010-2014' }],
    skills: ['Enterprise Sales', 'Healthcare', 'Hospital Networks', 'Sales Leadership'],
    about: 'Healthcare GTM leader scaling CareLoop post-Series B. Hiring 4 enterprise AEs and a Clinical Implementation Manager.',
    location: 'Boston, MA',
    connectionsCount: 3100,
  },

  // Jasmine Park — agency CMO growth-stage (mock_12)
  'linkedin.com/in/jasminepark': {
    fullName: 'Jasmine Park',
    headline: 'CMO at Halo Creative · brand-led growth marketing for consumer startups',
    currentPosition: {
      title: 'Chief Marketing Officer',
      company: 'Halo Creative',
      startDate: '2019-04',
      description: 'Founder. 60-person agency. Just hit $1.5M ARR milestone and won Trove Insurance from incumbent Mekanism.',
    },
    experience: [
      { title: 'CMO / Founder', company: 'Halo Creative', startDate: '2019-04' },
      { title: 'Creative Director', company: 'Wieden+Kennedy', startDate: '2011-06', endDate: '2019-03' },
    ],
    education: [{ institution: 'Art Center College of Design', degree: 'BFA', field: 'Graphic Design', years: '2007-2011' }],
    skills: ['Brand Strategy', 'Paid Media', 'Consumer Marketing', 'Agency Leadership'],
    about: 'Halo Creative blends brand creative with paid acquisition for 22 funded consumer brands.',
    location: 'San Francisco, CA',
    connectionsCount: 1800,
  },

  // Henry Wallace — signal-sparse manufacturer (mock_10) — graceful path
  'linkedin.com/in/henrywallace': {
    fullName: 'Henry Wallace',
    headline: 'Plant Manager · Wallace Steel Co.',
    currentPosition: {
      title: 'Plant Manager',
      company: 'Wallace Steel Co.',
      startDate: '2009-03',
    },
    experience: [
      { title: 'Plant Manager', company: 'Wallace Steel Co.', startDate: '2009-03' },
      { title: 'Operations Lead', company: 'Wallace Steel Co.', startDate: '2001-06', endDate: '2009-02' },
    ],
    education: [{ institution: 'Penn State', degree: 'BS', field: 'Industrial Engineering', years: '1992-1996' }],
    skills: ['Manufacturing', 'Steel'],
    location: 'Pittsburgh, PA',
    connectionsCount: 280,
  },
}

// ─── Curated posts ──────────────────────────────────────────────────

const MOCK_POSTS: Record<string, LinkedinPost[]> = {
  'linkedin.com/in/sarahchen': [
    {
      id: 'linkedin_post_sarahchen_01',
      postedAt: daysAgoIso(3),
      content:
        'We just closed our $14M Series A led by Costanoa Ventures. Three years building the product analytics layer founders actually want. Hiring our Founding AE in SF — DM me if you want to build the GTM motion from scratch.',
      reactions: 412,
      comments: 38,
      url: 'https://linkedin.com/posts/sarahchen_series-a-pulse',
    },
    {
      id: 'linkedin_post_sarahchen_02',
      postedAt: daysAgoIso(14),
      content:
        'Most founders churn analytics tools every 6 months because the existing stack costs $40K/yr just to answer "did this feature work?" That gap is why we built Pulse.',
      reactions: 180,
      comments: 22,
      url: 'https://linkedin.com/posts/sarahchen_analytics-stack',
    },
    {
      id: 'linkedin_post_sarahchen_03',
      postedAt: daysAgoIso(28),
      content:
        'Speaking at SaaStr next month on the difference between activation metrics that move retention vs the ones that just look good in board decks.',
      reactions: 95,
      comments: 11,
      url: 'https://linkedin.com/posts/sarahchen_saastr-keynote',
    },
  ],
  'linkedin.com/in/priyaiyer': [
    {
      id: 'linkedin_post_priyaiyer_01',
      postedAt: daysAgoIso(7),
      content: 'First paid Mosaic customer signed. Eight design partners → one wallet pull. Onwards.',
      reactions: 124,
      comments: 18,
      url: 'https://linkedin.com/posts/priyaiyer_first-paid',
    },
    {
      id: 'linkedin_post_priyaiyer_02',
      postedAt: daysAgoIso(35),
      content:
        'Founder-led support means dropping context. We are building Mosaic so the founder never has to ask "wait, what did Slack say last week?" again.',
      reactions: 67,
      comments: 9,
      url: 'https://linkedin.com/posts/priyaiyer_founder-support',
    },
  ],
  'linkedin.com/in/lauraperezedu': [
    {
      id: 'linkedin_post_lauraperezedu_01',
      postedAt: daysAgoIso(21),
      content:
        'Orgullosa de anunciar el convenio entre Colegio San Andrés y Universidad EAFIT para articulación académica. Cinco años en construcción. Nuestros estudiantes ya tienen ruta directa.',
      reactions: 86,
      comments: 14,
      url: 'https://linkedin.com/posts/lauraperezedu_eafit',
    },
  ],
  'linkedin.com/in/diegorestrepo': [
    {
      id: 'linkedin_post_diegorestrepo_01',
      postedAt: daysAgoIso(45),
      content:
        'Nueva línea de crédito con Bancolombia por COP 50 mil millones. Llevamos factoring a las PYMES del Eje Cafetero. 18 años después, seguimos creciendo.',
      reactions: 54,
      comments: 7,
      url: 'https://linkedin.com/posts/diegorestrepo_bancolombia',
    },
  ],
  'linkedin.com/in/rebeccalin': [
    {
      id: 'linkedin_post_rebeccalin_01',
      postedAt: daysAgoIso(5),
      content:
        'CareLoop just signed Atrium Health — 12 hospitals across the Carolinas. Hiring 2 enterprise AEs and a clinical implementation lead to handle the expansion. Reach out if hospital GTM is your thing.',
      reactions: 240,
      comments: 31,
      url: 'https://linkedin.com/posts/rebeccalin_atrium',
    },
    {
      id: 'linkedin_post_rebeccalin_02',
      postedAt: daysAgoIso(40),
      content: 'Six months into VP Sales at CareLoop. Series B closed, the team is building, and 22% readmission reduction is becoming a standard CFO conversation.',
      reactions: 110,
      comments: 12,
      url: 'https://linkedin.com/posts/rebeccalin_six-months',
    },
  ],
  'linkedin.com/in/jasminepark': [
    {
      id: 'linkedin_post_jasminepark_01',
      postedAt: daysAgoIso(10),
      content:
        'Halo just won Trove Insurance from Mekanism. Twelve-month doubling for the agency, $1.5M ARR milestone last week. Hiring a Senior Paid Social Lead and a Brand Strategist.',
      reactions: 198,
      comments: 24,
      url: 'https://linkedin.com/posts/jasminepark_trove-win',
    },
  ],
  // Henry Wallace — intentionally no posts. Graceful empty path.
  'linkedin.com/in/henrywallace': [],
}

// ─── Public mock helpers ────────────────────────────────────────────

/**
 * Look up the curated profile for a LinkedIn URL. Returns null on miss
 * so callers can synthesize an empty result deterministically.
 */
export function mockScrapeLinkedinProfile(url: string): ApifyLinkedinProfileScrapeResult | null {
  const key = toBareLinkedinKey(url)
  const profile = MOCK_PROFILES[key]
  if (!profile) return null
  return {
    profile,
    metadata: {
      profileUrl: `https://${key}`,
      scrapedAt: new Date(REFERENCE_NOW).toISOString(),
    },
    costUsd: COST_PER_PROFILE_USD,
  }
}

/**
 * Look up curated posts. Empty array for known profiles with no posts;
 * null for unknown URLs (caller chooses synthesizeEmptyPosts).
 */
export function mockScrapeLinkedinPosts(
  url: string,
  options: { limit?: number; sinceDays?: number } = {},
): ApifyLinkedinPostsScrapeResult | null {
  const key = toBareLinkedinKey(url)
  const posts = MOCK_POSTS[key]
  if (posts === undefined) return null
  const sinceDays = options.sinceDays ?? 90
  const cutoff = REFERENCE_NOW - sinceDays * 24 * 60 * 60 * 1000
  const filtered = posts.filter((p) => new Date(p.postedAt).getTime() >= cutoff)
  const limit = options.limit ?? 10
  const sliced = filtered.slice(0, limit)
  return {
    posts: sliced,
    metadata: {
      profileUrl: `https://${key}`,
      postsCount: sliced.length,
      scrapedAt: new Date(REFERENCE_NOW).toISOString(),
    },
    costUsd: COST_PER_POSTS_USD,
  }
}

/**
 * Graceful fallback for unknown profiles. Returns a thin, valid-looking
 * profile so downstream extraction can still produce an empty-signal
 * dossier rather than crash.
 */
export function synthesizeUnknownProfile(url: string): ApifyLinkedinProfileScrapeResult {
  const key = toBareLinkedinKey(url)
  return {
    profile: {
      fullName: 'Unknown LinkedIn profile',
      headline: '',
      experience: [],
      education: [],
      skills: [],
    },
    metadata: {
      profileUrl: `https://${key}`,
      scrapedAt: new Date(REFERENCE_NOW).toISOString(),
    },
    costUsd: COST_PER_PROFILE_USD,
  }
}

export function synthesizeEmptyPosts(url: string): ApifyLinkedinPostsScrapeResult {
  const key = toBareLinkedinKey(url)
  return {
    posts: [],
    metadata: {
      profileUrl: `https://${key}`,
      postsCount: 0,
      scrapedAt: new Date(REFERENCE_NOW).toISOString(),
    },
    costUsd: COST_PER_POSTS_USD,
  }
}

export { MOCK_POSTS, MOCK_PROFILES, COST_PER_POSTS_USD, COST_PER_PROFILE_USD }
