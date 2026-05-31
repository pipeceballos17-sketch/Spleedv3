import { VercelBrowserClient } from '../vercel-browser/client'
import { VercelBrowserProvider } from '../vercel-browser/provider'
import { BrowserFarmManagedProvider } from './providers/browser-farm-managed'
import { ChromeCdpLocalProvider } from './providers/chrome-cdp-local'
import { HttpDirectProvider } from './providers/http-direct'
import type { BrowserProvider } from './provider'
import type { BrowserBlockedBy, BrowserTier, ScrapeAttempt, ScrapeRequest, ScrapeResult } from './types'

export interface BrowserOrchestratorDeps {
  providers: Map<BrowserTier, BrowserProvider>
}

/**
 * Escalation routing (Sprint 9 CP2, Juan's bypass matrix). Returns the next
 * tier to try, or null to stop. Anti-bot challenges that a heavier browser can
 * defeat (Imperva/WAF/Cloudflare) escalate; structural blocks (geo, auth) stop.
 *
 *   Tier 1 + imperva|waf            → Tier 3 (skip Tier 2 — headless won't help)
 *   Tier 1 + cloudflare|rate_limit|unknown → Tier 2
 *   Tier 2 + imperva|waf|cloudflare → Tier 3 (CDP can sometimes clear CF)
 *   anything else                   → stop
 */
function escalate(from: BrowserTier, blockedBy: BrowserBlockedBy): BrowserTier | null {
  if (from === 'http_direct') {
    if (blockedBy === 'imperva' || blockedBy === 'waf') return 'chrome_cdp_local'
    if (blockedBy === 'cloudflare' || blockedBy === 'rate_limit' || blockedBy === 'unknown') {
      return 'vercel_browser'
    }
    return null
  }
  if (from === 'vercel_browser') {
    if (blockedBy === 'imperva' || blockedBy === 'waf' || blockedBy === 'cloudflare') {
      return 'chrome_cdp_local'
    }
    return null
  }
  return null
}

const totalCost = (attempts: ScrapeAttempt[]): number =>
  attempts.reduce((sum, a) => sum + a.costUsd, 0)

/**
 * Tier-escalating scrape orchestrator. Pure (no DB / side effects) — returns a
 * ScrapeResult whose `attempts[]` the caller (Profiler worker) turns into
 * per-tier cost_events. A Tier 3/4 stub throws if escalation reaches it, which
 * the worker's try/catch surfaces (Sprint 9 CP2 never reaches it in mock —
 * Tier 1 succeeds for the company-website shape).
 */
export class BrowserOrchestrator {
  private readonly providers: Map<BrowserTier, BrowserProvider>

  constructor(deps: BrowserOrchestratorDeps) {
    this.providers = deps.providers
  }

  async scrape(request: ScrapeRequest): Promise<ScrapeResult> {
    const attempts: ScrapeAttempt[] = []
    let current: BrowserTier | null = request.tier ?? 'http_direct'
    let lastFailure: Extract<ScrapeResult, { success: false }> | null = null

    while (current) {
      const provider = this.providers.get(current)
      if (!provider) {
        lastFailure = {
          success: false, tierUsed: current, costUsd: totalCost(attempts), blockedBy: 'unknown',
          errorMessage: `No provider registered for tier ${current}`, latencyMs: 0, attempts: [...attempts],
        }
        break
      }

      // May throw for a not-yet-implemented tier (Tier 3/4 stubs) — intentional;
      // the worker catches and records the enrichment failure.
      const result = await provider.scrape({ ...request, tier: current })
      const attempt = result.attempts[0] ?? {
        tier: current, costUsd: result.costUsd, latencyMs: result.latencyMs,
        success: result.success, blockedBy: result.success ? undefined : result.blockedBy,
      }
      attempts.push(attempt)

      if (result.success) {
        return { ...result, attempts, costUsd: totalCost(attempts) }
      }

      lastFailure = result
      if (request.tier) break // explicit tier → no auto-escalation
      current = escalate(current, result.blockedBy)
    }

    return {
      success: false,
      tierUsed: attempts.at(-1)?.tier ?? request.tier ?? 'http_direct',
      costUsd: totalCost(attempts),
      blockedBy: lastFailure?.blockedBy ?? 'unknown',
      errorMessage: lastFailure?.errorMessage ?? 'All tiers exhausted',
      latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
      attempts,
    }
  }
}

/**
 * Default orchestrator: Tier 1 (http-direct) + Tier 2 (vercel-browser, wrapping
 * the supplied client) + Tier 3/4 stubs. The Profiler worker builds one of
 * these per job (passing its VercelBrowserClient so mock/live mode aligns).
 */
export function createDefaultBrowserOrchestrator(vercelClient?: VercelBrowserClient): BrowserOrchestrator {
  const providers = new Map<BrowserTier, BrowserProvider>([
    ['http_direct', new HttpDirectProvider()],
    ['vercel_browser', new VercelBrowserProvider(vercelClient)],
    ['chrome_cdp_local', new ChromeCdpLocalProvider()],
    ['browser_farm_managed', new BrowserFarmManagedProvider()],
  ])
  return new BrowserOrchestrator({ providers })
}
