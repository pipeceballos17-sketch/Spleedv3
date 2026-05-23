export {
  extractCompanyWebsiteSignals,
  type ExtractCompanyWebsiteSignalsInput,
} from './company-website-extraction'
export {
  extractLinkedinSignals,
  type ExtractLinkedinSignalsInput,
} from './linkedin-extraction'
export {
  extractNewsSignals,
  type ExtractNewsSignalsInput,
} from './news-extraction'
export { synthesizeDossier } from './synthesis'
export {
  PROFILER_SYNTHESIS_PROMPT,
  PROFILER_SYSTEM_PROMPT,
  buildCompanyWebsiteUserPrompt,
  buildLinkedinUserPrompt,
  buildNewsUserPrompt,
  buildSynthesisUserPrompt,
  type BuildCompanyWebsiteUserPromptInput,
  type BuildLinkedinUserPromptInput,
  type BuildNewsUserPromptInput,
  type BuildSynthesisUserPromptInput,
} from './prompts'
export type {
  CompanyStage,
  CompanyWebsiteSignalsWithIds,
  LeadShape,
  LinkedinExtractionResult,
  NewsExtractionResult,
  ProfilerCompanyWebsiteExtractionResult,
  ProfilerSourceName,
  SynthesisInput,
  SynthesisSourceInput,
  SynthesizedDossier,
  SynthesizedHookCandidateWithId,
} from './types'
