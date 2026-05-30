/**
 * Composer tool handlers (Sprint 9+ seam — intentionally empty in Sprint 8).
 *
 * Sprint 8's Composer is a fixed 4-step pipeline with NO tool-use loop: every
 * step is a single structured LLM call. Sprint 9+ may let the draft-composition
 * step call tools (e.g. fetch the lead's microsite asset URL, look up a Cal.com
 * scheduling link, pull a fresh tracking signal) via an Anthropic tool-use loop
 * — mirroring the DeepResearchAgent's handler registry. This module reserves
 * the home for those handlers so the wiring is additive, not a refactor.
 */

/** Registered Composer tool handlers. Empty until Sprint 9+. */
export const COMPOSER_TOOL_HANDLERS: Record<string, never> = {}
