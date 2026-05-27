/**
 * Deep research agent types (Sprint 7b — Phase 7).
 *
 * Re-exports the integration-layer DeepResearchOutput (the LLM+tools call
 * result) and defines the agent-layer input that the Profiler worker
 * assembles from the lead row, ICP row, and Phase 6 synthesis.
 */

import type { DeepResearchOutput, IcpShape } from '@spleed/integrations/anthropic'
import type { LeadShape, SynthesizedDossier } from '../profiler/types'

export type { DeepResearchOutput }

export interface DeepResearchInput {
  lead: LeadShape
  icp: IcpShape
  /**
   * From icps.deep_research_guidance — tenant steering toward
   * industry-specific public sources. NULL = universal core-4 research
   * only. Injected into the user prompt; preserves horizontal positioning
   * (no Spleed-side industry hardcoding).
   */
  guidance: string | null
  /** Phase 6 synthesis output — gives the research a starting dossier to deepen. */
  initialSynthesis: SynthesizedDossier
}
