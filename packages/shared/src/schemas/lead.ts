import { z } from 'zod'

/**
 * Lead lifecycle states. Mirrors lead_status pgEnum in packages/db/src/schema/enums.ts.
 * Transitions documented in COMMENT ON TYPE (see 05-policies.sql).
 */
export const LeadStatusSchema = z.enum([
  'discovered',
  'enriching',
  'enriched',
  'composing',
  'composed',
  'engaged',
  'tracking',
  'tracking_paused_human',
  'gift_pending',
  'booked',
  'lost',
])
export type LeadStatus = z.infer<typeof LeadStatusSchema>

/**
 * Source of lead discovery. Scout v0.1 emits one of the first 5; manual /
 * manual_imessage are added by BACKLOG-004 in Sprint 8.
 */
export const LeadFoundViaSchema = z.enum([
  'apollo',
  'crunchbase_funding',
  'hiring_signal',
  'github',
  'google_search',
  'manual',
  'manual_imessage',
])
export type LeadFoundVia = z.infer<typeof LeadFoundViaSchema>

/**
 * Lead creation payload — snake_case to align EXACTLY with the JSON Scout
 * emits per agent-prompts.md §1 output_format.
 *
 * Scout produces this shape; the agent runtime validates with this schema and
 * then calls `leadCreateToInsert` to convert to Drizzle's camelCase shape.
 *
 * orgId and icpId are NOT here — they come from the agent runtime context,
 * not from the agent's reasoning output.
 */
export const LeadCreateSchema = z.object({
  first_name: z.string().min(1).max(120),
  last_name: z.string().min(1).max(120),
  full_name: z.string().min(1).max(240),
  company: z.string().min(1).max(240),
  role: z.string().min(1).max(240),
  email: z.string().email().nullable().default(null),
  linkedin_url: z.string().url().nullable().default(null),
  x_handle: z.string().nullable().default(null),
  github_handle: z.string().nullable().default(null),
  company_domain: z.string().nullable().default(null),
  found_via: LeadFoundViaSchema,
  fit_score: z.number().min(0).max(1),
  fit_reasoning: z.string().min(1).max(500),
  raw_signals: z.record(z.string(), z.unknown()).default({}),
})
export type LeadCreate = z.infer<typeof LeadCreateSchema>

/**
 * Convert a validated Scout LeadCreate to the camelCase shape Drizzle expects
 * for `db.insert(leads).values(...)`. orgId and icpId come from runtime context.
 */
export function leadCreateToInsert(
  input: LeadCreate,
  context: { orgId: string; icpId?: string | null },
) {
  return {
    orgId: context.orgId,
    icpId: context.icpId ?? null,
    firstName: input.first_name,
    lastName: input.last_name,
    fullName: input.full_name,
    company: input.company,
    role: input.role,
    email: input.email,
    linkedinUrl: input.linkedin_url,
    xHandle: input.x_handle,
    githubHandle: input.github_handle,
    companyDomain: input.company_domain,
    foundVia: input.found_via,
    fitScore: input.fit_score,
    fitReasoning: input.fit_reasoning,
    fitScoreComputedAt: new Date(),
    rawSignals: input.raw_signals,
  }
}

/**
 * Generic update payload — any subset of mutable lead fields. camelCase.
 * Used by tRPC routes (Sprint 8/9) and by agents updating status mid-pipeline.
 */
export const LeadUpdateSchema = z.object({
  status: LeadStatusSchema.optional(),
  fullName: z.string().min(1).max(240).optional(),
  firstName: z.string().min(1).max(120).optional(),
  lastName: z.string().min(1).max(120).optional(),
  company: z.string().min(1).max(240).optional(),
  role: z.string().min(1).max(240).optional(),
  email: z.string().email().nullable().optional(),
  linkedinUrl: z.string().url().nullable().optional(),
  xHandle: z.string().nullable().optional(),
  githubHandle: z.string().nullable().optional(),
  companyDomain: z.string().nullable().optional(),
  fitScore: z.number().min(0).max(1).optional(),
  fitReasoning: z.string().min(1).max(500).optional(),
  lostReason: z.string().max(500).nullable().optional(),
})
export type LeadUpdate = z.infer<typeof LeadUpdateSchema>

/**
 * Read-side DTO for serializing leads rows to clients (future tRPC, Sprint 8/9).
 */
export const LeadDtoSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  icpId: z.string().uuid().nullable(),
  status: LeadStatusSchema,
  fullName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  company: z.string(),
  role: z.string(),
  companyDomain: z.string().nullable(),
  email: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  xHandle: z.string().nullable(),
  githubHandle: z.string().nullable(),
  foundVia: z.string(),
  fitScore: z.number().nullable(),
  fitReasoning: z.string().nullable(),
  fitScoreComputedAt: z.coerce.date().nullable(),
  discoveredAt: z.coerce.date(),
  enrichedAt: z.coerce.date().nullable(),
  firstOutreachAt: z.coerce.date().nullable(),
  bookedAt: z.coerce.date().nullable(),
  lostAt: z.coerce.date().nullable(),
  lostReason: z.string().nullable(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type LeadDto = z.infer<typeof LeadDtoSchema>
