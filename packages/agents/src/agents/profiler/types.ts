/**
 * Profiler agent types (Sprint 6a — company website source only).
 *
 * The raw signals JSON returned by the LLM (@spleed/integrations/anthropic
 * ExtractedCompanyWebsiteSignals) lacks hookId uuids. The Profiler agent
 * layer generates one uuid per hook_candidate and attaches it before
 * persistence — that ID is the bridge between hook_candidates and the
 * evidence_urls jsonb (Sprint 6b screenshot capture writes
 * { hookId, url, capturedAt, sourceType } rows pointing back at hooks).
 */

import type {
  CompanyStage,
  ExtractedCompanyWebsiteSignals,
} from '@spleed/integrations/anthropic'

export type { CompanyStage }

export interface CompanyWebsiteSignalsWithIds {
  company_stage: ExtractedCompanyWebsiteSignals['company_stage']
  recent_news: string[]
  pain_signals: string[]
  hiring_signals: string[]
  growth_signals: string[]
  hook_candidates: Array<{
    hookId: string
    hook: string
    evidence: string
    confidence: number
  }>
}

export interface ProfilerCompanyWebsiteExtractionResult {
  signals: CompanyWebsiteSignalsWithIds
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
}

/**
 * Subset of Lead fields Profiler's extraction reads. Leaf-shape pattern
 * (mirrors anthropic IcpShape) keeps tests free of full Drizzle row
 * construction. The worker (Sprint 6a CP3) projects the real `leads` row
 * onto this shape before invoking extractCompanyWebsiteSignals.
 */
export interface LeadShape {
  fullName: string
  firstName: string
  lastName: string
  company: string
  role: string
  /** Apollo + manual ingest both may leave this NULL — guard at consumer. */
  companyDomain?: string | null
  email?: string | null
  linkedinUrl?: string | null
}
