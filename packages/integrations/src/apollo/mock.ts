/**
 * Apollo mock fixtures — 15 candidates with deliberate variety so Scout's
 * SQL fit_score can be exercised across the full 0-100 range in tests.
 *
 * Variety dimensions:
 *   - Industries: saas, fintech, education, healthcare, manufacturing, marketing
 *   - Company sizes: 5 → 250
 *   - Locations: US (SF/NYC/Austin), LatAm (Bogotá/CDMX), Europe (Berlin)
 *   - Titles: Founder, CEO, CTO, VP Sales, CFO, CMO, Head of Product, Director
 *   - Seniorities: founder, c_suite, vp, director
 *   - Technographics: some match common Spleed ICPs, some don't
 *   - Email coverage: 12/15 have email; 3 leave it null to exercise findEmail
 *
 * IDs follow `apollo_mock_NN` for grep-ability in test failures.
 */

import type { ApolloPerson } from './types'

export const MOCK_CANDIDATES: ApolloPerson[] = [
  // Strong-fit cluster: B2B SaaS founders, US, modern stack
  {
    id: 'apollo_mock_01',
    full_name: 'Sarah Chen',
    first_name: 'Sarah',
    last_name: 'Chen',
    title: 'Founder & CEO',
    company: 'Pulse Analytics',
    company_domain: 'pulseanalytics.io',
    industry: 'saas',
    company_size: 12,
    location: 'San Francisco, CA',
    technologies: ['stripe', 'segment', 'snowflake', 'react'],
    seniority: 'founder',
    email: 'sarah@pulseanalytics.io',
    linkedin_url: 'https://linkedin.com/in/sarahchen',
    x_handle: '@sarahchen',
    github_handle: 'sarahchen',
  },
  {
    id: 'apollo_mock_02',
    full_name: 'Marcus Reed',
    first_name: 'Marcus',
    last_name: 'Reed',
    title: 'Co-Founder, CTO',
    company: 'Loop Devtools',
    company_domain: 'loopdev.io',
    industry: 'saas',
    company_size: 8,
    location: 'Austin, TX',
    technologies: ['typescript', 'postgres', 'kubernetes', 'stripe'],
    seniority: 'founder',
    email: 'marcus@loopdev.io',
    linkedin_url: 'https://linkedin.com/in/marcusreed',
    github_handle: 'mreed',
  },
  {
    id: 'apollo_mock_03',
    full_name: 'Priya Iyer',
    first_name: 'Priya',
    last_name: 'Iyer',
    title: 'Founder',
    company: 'Mosaic Inbox',
    company_domain: 'mosaicinbox.com',
    industry: 'saas',
    company_size: 6,
    location: 'New York, NY',
    technologies: ['stripe', 'postgres', 'segment'],
    seniority: 'founder',
    email: 'priya@mosaicinbox.com',
    linkedin_url: 'https://linkedin.com/in/priyaiyer',
  },

  // Fintech B2B (traditional/Zolvo-style) — low digital footprint examples
  {
    id: 'apollo_mock_04',
    full_name: 'Diego Restrepo',
    first_name: 'Diego',
    last_name: 'Restrepo',
    title: 'CEO',
    company: 'Andean Factoring',
    company_domain: 'andeanfactoring.co',
    industry: 'fintech',
    company_size: 45,
    location: 'Bogotá, Colombia',
    technologies: ['salesforce', 'sap'],
    seniority: 'c_suite',
    email: 'd.restrepo@andeanfactoring.co',
    linkedin_url: 'https://linkedin.com/in/diegorestrepo',
  },
  {
    id: 'apollo_mock_05',
    full_name: 'Carla Mendoza',
    first_name: 'Carla',
    last_name: 'Mendoza',
    title: 'CFO',
    company: 'PymeCredit',
    company_domain: 'pymecredit.mx',
    industry: 'fintech',
    company_size: 80,
    location: 'Ciudad de México, Mexico',
    technologies: ['oracle', 'sap'],
    seniority: 'c_suite',
    email: 'cmendoza@pymecredit.mx',
    linkedin_url: 'https://linkedin.com/in/carlamendoza',
  },

  // Education B2B (Grupo500-style)
  {
    id: 'apollo_mock_06',
    full_name: 'Laura Pérez',
    first_name: 'Laura',
    last_name: 'Pérez',
    title: 'Director of Academics',
    company: 'Colegio San Andrés',
    company_domain: 'colegiosanandres.edu.co',
    industry: 'education',
    company_size: 120,
    location: 'Medellín, Colombia',
    technologies: ['google_workspace'],
    seniority: 'director',
    // email intentionally null — Scout has to call findEmail or skip lead
    email: null,
    linkedin_url: 'https://linkedin.com/in/lauraperezedu',
  },
  {
    id: 'apollo_mock_07',
    full_name: 'Esteban Vargas',
    first_name: 'Esteban',
    last_name: 'Vargas',
    title: 'Rector',
    company: 'Instituto del Norte',
    company_domain: 'institutodelnorte.edu.co',
    industry: 'education',
    company_size: 75,
    location: 'Barranquilla, Colombia',
    technologies: ['google_workspace', 'moodle'],
    seniority: 'c_suite',
    email: 'rector@institutodelnorte.edu.co',
  },

  // Healthcare B2B
  {
    id: 'apollo_mock_08',
    full_name: 'Rebecca Lin',
    first_name: 'Rebecca',
    last_name: 'Lin',
    title: 'VP of Sales',
    company: 'CareLoop Health',
    company_domain: 'careloophealth.com',
    industry: 'healthcare',
    company_size: 180,
    location: 'Boston, MA',
    technologies: ['salesforce', 'hubspot'],
    seniority: 'vp',
    email: 'rlin@careloophealth.com',
    linkedin_url: 'https://linkedin.com/in/rebeccalin',
  },
  {
    id: 'apollo_mock_09',
    full_name: 'Tomás Acosta',
    first_name: 'Tomás',
    last_name: 'Acosta',
    title: 'Head of Product',
    company: 'MedFlow LatAm',
    company_domain: 'medflow.la',
    industry: 'healthcare',
    company_size: 35,
    location: 'Buenos Aires, Argentina',
    technologies: ['typescript', 'aws', 'postgres'],
    seniority: 'director',
    email: 'tacosta@medflow.la',
    linkedin_url: 'https://linkedin.com/in/tomasacosta',
  },

  // Manufacturing (anti-fit for typical SaaS ICP — low fit_score expected)
  {
    id: 'apollo_mock_10',
    full_name: 'Henry Wallace',
    first_name: 'Henry',
    last_name: 'Wallace',
    title: 'Plant Manager',
    company: 'Wallace Steel Co.',
    company_domain: 'wallacesteel.com',
    industry: 'manufacturing',
    company_size: 240,
    location: 'Pittsburgh, PA',
    technologies: ['sap'],
    seniority: 'manager',
    email: 'h.wallace@wallacesteel.com',
  },
  {
    id: 'apollo_mock_11',
    full_name: 'Klaus Hoffmann',
    first_name: 'Klaus',
    last_name: 'Hoffmann',
    title: 'Operations Director',
    company: 'Bauwerk Manufacturing',
    company_domain: 'bauwerk.de',
    industry: 'manufacturing',
    company_size: 200,
    location: 'Berlin, Germany',
    technologies: ['oracle'],
    seniority: 'director',
    // email null — non-public profile
    email: null,
    linkedin_url: 'https://linkedin.com/in/klaushoffmann',
  },

  // Marketing leaders (different title bucket)
  {
    id: 'apollo_mock_12',
    full_name: 'Jasmine Park',
    first_name: 'Jasmine',
    last_name: 'Park',
    title: 'CMO',
    company: 'Halo Creative',
    company_domain: 'halocreative.co',
    industry: 'marketing',
    company_size: 60,
    location: 'San Francisco, CA',
    technologies: ['hubspot', 'segment', 'webflow'],
    seniority: 'c_suite',
    email: 'jasmine@halocreative.co',
    linkedin_url: 'https://linkedin.com/in/jasminepark',
    x_handle: '@jpark_cmo',
  },
  {
    id: 'apollo_mock_13',
    full_name: 'Aaron Goldberg',
    first_name: 'Aaron',
    last_name: 'Goldberg',
    title: 'VP of Marketing',
    company: 'Northstar Outbound',
    company_domain: 'northstaroutbound.com',
    industry: 'marketing',
    company_size: 90,
    location: 'Toronto, Canada',
    technologies: ['hubspot', 'apollo', 'clay'],
    seniority: 'vp',
    email: 'aaron.g@northstaroutbound.com',
  },

  // Edge cases: very small + very large, no tech stack reported
  {
    id: 'apollo_mock_14',
    full_name: 'Yuki Tanaka',
    first_name: 'Yuki',
    last_name: 'Tanaka',
    title: 'Solo Founder',
    company: 'Tanaka Studio',
    company_domain: 'tanakastudio.jp',
    industry: 'saas',
    company_size: 1,
    location: 'Tokyo, Japan',
    // no technologies array — tests technographics_match with empty input
    seniority: 'founder',
    // email null — solo founder, no API exposure
    email: null,
    linkedin_url: 'https://linkedin.com/in/yukitanaka',
    x_handle: '@yuki_t',
    github_handle: 'yukitanaka',
  },
  {
    id: 'apollo_mock_15',
    full_name: 'Margaret Olsen',
    first_name: 'Margaret',
    last_name: 'Olsen',
    title: 'Director of Sales Operations',
    company: 'Convex Industries',
    company_domain: 'convexindustries.com',
    industry: 'manufacturing',
    company_size: 250,
    location: 'Chicago, IL',
    technologies: ['salesforce', 'oracle'],
    seniority: 'director',
    email: 'molsen@convexindustries.com',
    linkedin_url: 'https://linkedin.com/in/margaretolsen',
  },
]

/**
 * Filter mock candidates against the same fields the real Apollo API would.
 * Implements a permissive AND across filter dimensions — if a field is omitted
 * on a candidate, that dimension is skipped (no false rejection).
 *
 * Sprint 5a is intentionally simple: substring/case-insensitive matching on
 * industries/locations/titles. Sprint 7's real client will use Apollo's
 * server-side filter language for parity.
 */
export function filterMockCandidates(
  filters: {
    industries?: string[]
    companySize?: { min?: number; max?: number }
    locations?: string[]
    titles?: string[]
    seniorities?: string[]
    technologies?: string[]
  },
  pool: ApolloPerson[] = MOCK_CANDIDATES,
): ApolloPerson[] {
  const norm = (s: string): string => s.toLowerCase()
  const includesAny = (haystack: string, needles: string[]): boolean =>
    needles.some((n) => norm(haystack).includes(norm(n)))

  return pool.filter((p) => {
    if (filters.industries && filters.industries.length > 0) {
      if (!p.industry || !filters.industries.some((i) => norm(p.industry!) === norm(i))) {
        return false
      }
    }
    if (filters.companySize) {
      if (filters.companySize.min !== undefined && (p.company_size ?? 0) < filters.companySize.min) {
        return false
      }
      if (filters.companySize.max !== undefined && (p.company_size ?? Number.MAX_SAFE_INTEGER) > filters.companySize.max) {
        return false
      }
    }
    if (filters.locations && filters.locations.length > 0) {
      if (!p.location || !filters.locations.some((l) => includesAny(p.location!, [l]))) {
        return false
      }
    }
    if (filters.titles && filters.titles.length > 0) {
      if (!includesAny(p.title, filters.titles)) {
        return false
      }
    }
    if (filters.seniorities && filters.seniorities.length > 0) {
      if (!p.seniority || !filters.seniorities.some((s) => norm(p.seniority!) === norm(s))) {
        return false
      }
    }
    if (filters.technologies && filters.technologies.length > 0) {
      const techs = p.technologies ?? []
      if (!filters.technologies.some((t) => techs.some((pt) => norm(pt) === norm(t)))) {
        return false
      }
    }
    return true
  })
}
