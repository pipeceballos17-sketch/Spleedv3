import { z } from 'zod'

/**
 * Shape of icps.parsed_filters jsonb.
 *
 * version='1' is the Sprint 2 baseline. When the parser shape evolves
 * (Sprint 6+ adds icp_type and channel_priorities per BACKLOG-001), bump
 * the version and update the application layer to migrate older rows on read.
 */
export const IcpParsedFiltersV1Schema = z.object({
  version: z.literal('1'),
  titles: z.array(z.string()).optional(),
  industries: z.array(z.string()).optional(),
  companySizeMin: z.number().int().positive().optional(),
  companySizeMax: z.number().int().positive().optional(),
  geos: z.array(z.string()).optional(),
  fundingStages: z.array(z.string()).optional(),
  techStack: z.array(z.string()).optional(),
  buyingSignals: z.array(z.string()).optional(),
})
export type IcpParsedFiltersV1 = z.infer<typeof IcpParsedFiltersV1Schema>

/**
 * Discriminated union of all parser versions. As the shape evolves (v2, v3),
 * add cases here and the application layer can switch on `version`.
 */
export const IcpParsedFiltersSchema = z.discriminatedUnion('version', [
  IcpParsedFiltersV1Schema,
])
export type IcpParsedFilters = z.infer<typeof IcpParsedFiltersSchema>

/**
 * Input for creating an ICP. Founder writes natural language; parsed_filters
 * may be empty initially — the LLM parser (Sprint 6+) populates them async.
 */
export const IcpCreateSchema = z.object({
  name: z.string().min(1).max(120),
  definitionNaturalLanguage: z.string().min(20).max(2000),
  parsedFilters: IcpParsedFiltersSchema.optional(),
})
export type IcpCreate = z.infer<typeof IcpCreateSchema>

export const IcpUpdateSchema = IcpCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
})
export type IcpUpdate = z.infer<typeof IcpUpdateSchema>

/**
 * Read-side DTO for serializing icps rows to clients (future tRPC, Sprint 8/9).
 * camelCase as TS convention; the API layer is responsible for shape mapping.
 */
export const IcpDtoSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  definitionNaturalLanguage: z.string(),
  parsedFilters: IcpParsedFiltersSchema.nullable(),
  isActive: z.boolean(),
  naturalLanguageUpdatedAt: z.coerce.date(),
  parsedFiltersUpdatedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type IcpDto = z.infer<typeof IcpDtoSchema>
