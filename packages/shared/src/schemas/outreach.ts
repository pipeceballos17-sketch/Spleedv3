import { z } from 'zod'

/**
 * Shape of `assets.content` jsonb.
 *
 * Discriminated by `kind` (must mirror `assets.kind` enum) AND tagged by
 * `version`. Same evolution pattern as IcpParsedFiltersV1Schema — when shapes
 * change (Sprint 7+ refines microsite hero/sections, or new kinds arrive),
 * bump the version and add a new branch.
 *
 * Sprint 4 baseline: microsite is the only kind with a strongly typed shape
 * (it is 70%+ of Composer output per agent-prompts.md). Other kinds carry
 * passthrough() until Sprint 7 builds their renderers.
 */

const AssetContentVersion1 = z.literal('1')

export const AssetMicrositeContentV1Schema = z.object({
  version: AssetContentVersion1,
  kind: z.literal('microsite'),
  hero: z.object({
    h1: z.string().min(1).max(500),
    subhead: z.string().max(500).optional(),
  }),
  sections: z.array(
    z.object({
      heading: z.string(),
      body: z.string(),
      bullets: z.array(z.string()).optional(),
      sourceCitations: z
        .array(z.object({ url: z.string().url(), quote: z.string() }))
        .optional(),
    }),
  ).max(5).optional(),
  cta: z
    .object({
      calComUrl: z.string().url(),
      label: z.string().optional(),
    })
    .optional(),
  footer: z
    .object({
      founderName: z.string(),
      signatureImageUrl: z.string().url().nullable().optional(),
    })
    .optional(),
  trackingPixelId: z.string().uuid().optional(),
})
export type AssetMicrositeContentV1 = z.infer<typeof AssetMicrositeContentV1Schema>

// Other kinds carry passthrough() — Sprint 7+ replaces with strict shapes.
const AssetAuditContentV1Schema = z
  .object({ version: AssetContentVersion1, kind: z.literal('audit_pdf') })
  .passthrough()

const AssetRoiContentV1Schema = z
  .object({ version: AssetContentVersion1, kind: z.literal('roi_calculator') })
  .passthrough()

const AssetLoomContentV1Schema = z
  .object({ version: AssetContentVersion1, kind: z.literal('loom_script') })
  .passthrough()

const AssetDemoVideoContentV1Schema = z
  .object({ version: AssetContentVersion1, kind: z.literal('demo_video') })
  .passthrough()

/**
 * Discriminated union over all asset kinds (v1).
 * Add new versions as a parallel z.discriminatedUnion + extend the outer union.
 */
export const AssetContentSchema = z.discriminatedUnion('kind', [
  AssetMicrositeContentV1Schema,
  AssetAuditContentV1Schema,
  AssetRoiContentV1Schema,
  AssetLoomContentV1Schema,
  AssetDemoVideoContentV1Schema,
])
export type AssetContent = z.infer<typeof AssetContentSchema>
