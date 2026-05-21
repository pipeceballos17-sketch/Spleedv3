# Spleed — BACKLOG v0.2 (Pending changes for later sprints)

> Este archivo captura decisiones de producto y técnicas que NO van en MVP pero que tomamos conscientemente para implementar después.
>
> Cada item tiene: contexto + qué hacer + cuándo + dónde modificar. Cuando llegues al sprint correspondiente, lee este archivo primero.
>
> **Versión 0.2:** Agregados items 004-009 (manual enrichment, personal website, screenshot enrichment, social scraping ético, voice rejection, meeting notes capture).
> **Versión 0.3:** Agregado BACKLOG-010 (Tailwind v4 + Next 15 + Turbopack config check para Sprint 9).
> **Versión 0.4:** Agregados items 011-014 — LinkedIn engagement capture (★ HIGH VALUE), pricing & Sendblue alternativas, Lite tier deferred, competitive positioning iMessage-native. Sprint 1 cierre — 2026-05-11.
> **Versión 0.5:** Agregado BACKLOG-017 — Migrate large asset.content to Supabase Storage (Sprint 4 Decision E, target Sprint 12 hardening).

---

## Items por estado (resumen ejecutivo)

**EN MVP (sprints 1-12):**
- BACKLOG-001: ICP variability + channel priorities (Sprint 6)
- BACKLOG-004: Manual enrichment via URL en iMessage (Sprint 8)
- BACKLOG-005: Personal website enrichment (Sprint 6)
- BACKLOG-010: Tailwind v4 + Next 15 + Turbopack config check (Sprint 9)
- BACKLOG-016: Tech debt cleanup — SDK type casts (Sprint 12 hardening)
- BACKLOG-017: Migrate large asset.content (>50KB) to Supabase Storage (Sprint 12 hardening)

**PHASE 2 (sprints 13+):**
- BACKLOG-003: Profile pictures en iMessage
- BACKLOG-006: Screenshot enrichment via iMessage
- BACKLOG-007: Social scraping selectivo (Instagram/TikTok por ICP type)

**SPRINT 14+ (post-PMF features):**
- BACKLOG-002: Daily Brief swipe cards (ya en Sprint 9 spec)
- BACKLOG-009: Meeting Notes Capture ★ (HIGH VALUE)
- BACKLOG-011: LinkedIn engagement capture + co-pilot publishing ★ (HIGH VALUE)

**BUSINESS / ONGOING REVIEW:**
- BACKLOG-012: Pricing & unit economics + Sendblue alternativas (active monitoring)
- BACKLOG-014: Competitive positioning — iMessage-native space (refresh quarterly)

**DEFERRED (analyzed, not now):**
- BACKLOG-013: Lite tier consideration (reconsider 6 months post-MVP)

**REJECTED:**
- BACKLOG-008: Voice messages bidireccionales (iOS dictation cubre)

---

## Sprint 6 — Profiler agent

### BACKLOG-001: ICP variability + channel priorities

**Contexto:** El flow E2E v0.3 asume implícitamente que todos los founders venden a un ICP similar (tech founders B2B). En realidad, los founders Spleed venden a ICPs muy diversos: CFOs, engineers, designers, HR leaders, marketing leaders, creators.

**Qué hacer:**

1. **Onboarding wizard — pregunta "ICP type":**
   ```
   "What category does your ICP fit best?"
   - Technical (developers, engineers, CTOs)
   - Business operators (CFOs, COOs, RevOps)
   - Sales/marketing leaders (CMOs, VPs Sales)
   - Founders/CEOs
   - HR/People leaders
   - Designers/Creatives
   - Creators/B2C consumer
   - Other (specify)
   ```

2. **Onboarding wizard — "channel priorities":**
   ```
   "Where does your ICP live online? (rank by activity)"
   1. LinkedIn
   2. X / Twitter
   3. GitHub
   4. Reddit
   5. Hacker News
   6. Industry-specific newsletters
   7. Industry podcasts
   ```

3. **Schema:**
   - `icps.icp_type` (enum)
   - `icps.channel_priorities` (jsonb array ordered)

4. **Profiler prompt:** modular Tier 1/2/3 según prioridades. Para technical ICP, GitHub Tier 1; para CFO ICP, LinkedIn Tier 1.

5. **Gifter prompt:** catálogo según `icp_type`:
   - Technical → keyboards, dev books, espresso gear
   - Business operators → strategy books, premium notebooks
   - Sales leaders → business books, branded items, dining
   - HR → leadership books, wellness
   - Designers → design books, art supplies, premium stationery
   - Founders → business autobiographies, productivity tools
   - Creators/B2C → curated experiences, niche brands, lifestyle

6. **6 casos de uso:**
   - Caso A: B2B SaaS founder vende a otros founders
   - Caso B: DevTools founder vende a engineering managers
   - Caso C: Sales tooling founder vende a VPs of Sales
   - Caso D: HR tech founder vende a Heads of People
   - Caso E: FinTech founder vende a CFOs
   - Caso F: Marketing tool founder vende a CMOs

**Dónde modificar:**
- `/docs/e2e-flow-spec.md` — patch sección "Variabilidad por tenant"
- `/packages/db/schema/leads.ts` — columnas a `icps`
- `/packages/agents/profiler/prompt.md`
- `/packages/agents/gifter/prompt.md`
- `/apps/web/app/(app)/onboarding/icp-step.tsx`

**Cuándo:** Sprint 6, antes de empezar a codear Profiler.

---

### BACKLOG-005: Personal website enrichment

**Contexto:** Cuando dossier estándar encuentra un `personal_website_url` (común en founders, devs, creatives, writers), scraping del sitio agrega contexto rico: bio, proyectos, escritos, intereses.

**Qué hacer:**

1. Profiler agrega tool: `scrape_personal_website(url)`
2. Cuando dossier preliminar contiene `personal_website_url`, llamar tool
3. Apify general web scraper actor, máximo 2 páginas (about + index, o homepage + recent post), timeout 30s
4. Output structured: `{ bio, projects, themes, recent_writings }`
5. Dossier integration: sumar findings en sección `personal_signals`, sube confidence si corrobora otras señales

**Dónde modificar:**
- `/packages/agents/profiler/prompt.md`
- `/packages/agents/profiler/tools/scrape-website.ts`

**Cuándo:** Sprint 6, junto con BACKLOG-001. Relativamente fácil, suma valor real.

---

## Sprint 8 — Concierge agent

### BACKLOG-004: Manual enrichment via iMessage URL parsing

**Contexto:** Founder ve un perfil interesante mientras navega y quiere enriquecerlo sin abrir dashboard. Manda URL via iMessage a Concierge, este encola Profiler automáticamente.

**Por qué es alto valor:**
- Reduce fricción dramáticamente
- Captura "spontaneous interest" cuando founder está navegando
- Muy alta utilidad real para flow founder-led

**Qué hacer:**

1. **Concierge prompt — agregar intent type:**
   ```xml
   <intent_classification>
   - QUERY
   - COMMAND
   - MANUAL_ENRICHMENT_REQUEST  ← NEW
   - APPROVAL_RESPONSE
   - CLARIFICATION
   - CHITCHAT
   - AMBIGUOUS
   </intent_classification>
   ```

2. **URL parser:**
   - Regex para detectar URLs en inbound message
   - Plataformas soportadas:
     - `linkedin.com/in/*` → LinkedIn profile
     - `x.com/[handle]` o `twitter.com/[handle]` → X profile
     - `github.com/[user]` → GitHub user
     - Otros → unsupported
   - Múltiples URLs en un mensaje → procesa cada una

3. **Flow:**
   ```
   Founder: "enrich https://linkedin.com/in/sarah-chen"
   
   Concierge:
   1. Parsea URL → identifica plataforma
   2. Crea row en `leads`:
      - org_id del founder
      - linkedin_url = URL
      - status = 'discovered'
      - found_via = 'manual_imessage'
      - icp_id = ICP default del founder (o NULL)
   3. Encola Profiler
   4. Responde inmediato:
      "On it. Enriching the profile, dossier in ~5 min."
   5. Cuando Profiler termina, P1:
      "Done. Sarah Chen, CFO at Acme.
       Top pains: SDR ramp time
       Gift signal: Costa Rican coffee
       Recommended angle: pricing audit
       Want to compose? YES / NO"
   ```

4. **Edge cases:**
   - URL malformada → "That URL doesn't look right. Can you re-send?"
   - URL no soportada (Instagram/TikTok) → "Instagram URLs aren't supported yet. Got LinkedIn?"
   - Lead ya existe → "Sarah's already in your pipeline (status: enriched). Re-enrich? YES / NO"
   - Múltiples URLs → procesa todos, reporta consolidado

5. **Multi-URL handling:**
   ```
   Founder: "enrich these:
   linkedin.com/in/sarah
   linkedin.com/in/mike
   x.com/tina_park"
   
   Concierge: "On it — 3 leads queued. Will summarize when done."
   ```

**Schema changes:** ninguno (usa tablas existentes, just `found_via='manual_imessage'`)

**Dónde modificar:**
- `/packages/agents/concierge/prompt.md`
- `/packages/agents/concierge/url-parser.ts`
- `/packages/agents/concierge/handlers/manual-enrichment.ts`

**Cuándo:** Sprint 8, parte del MVP.

---

## Sprint 9 — Frontend

### BACKLOG-002: Daily Brief con swipe cards (mobile web)

**Contexto:** iMessage no soporta UI interactiva. Solución: Concierge manda digest en iMessage con link a página web mobile-first donde founder revisa leads pendientes con swipe gestures estilo Tinder.

**Qué hacer:**

1. **Nueva ruta:** `/d/[token]` en `/apps/web/app/(public)/d/[token]/page.tsx`

2. **Magic link auth:**
   - Token único generado al construir digest
   - Válido 1h, JWT firmado con `org_id`, `user_id`, expiración
   - No login persistente

3. **Schema:**
   ```sql
   CREATE TABLE daily_briefs (
     id uuid PRIMARY KEY,
     org_id uuid REFERENCES orgs(id),
     user_id uuid REFERENCES users(id),
     token text UNIQUE NOT NULL,
     expires_at timestamptz NOT NULL,
     viewed_at timestamptz,
     cards_data jsonb NOT NULL,
     created_at timestamptz DEFAULT now()
   );
   
   CREATE TABLE daily_brief_actions (
     id uuid PRIMARY KEY,
     brief_id uuid REFERENCES daily_briefs(id),
     card_id text NOT NULL,
     action text NOT NULL CHECK (action IN ('approved', 'skipped', 'opened_full')),
     created_at timestamptz DEFAULT now()
   );
   ```

4. **Cards en orden de prioridad:**
   - Pending approvals (gifts, sensitive outreach)
   - Replies received (founder action needed)
   - High-fit leads enriched (>0.85)
   - Meeting briefings (tomorrow)
   - Opens/engagements para revisar
   - Stuck leads suggesting action

5. **Gestures:**
   - Swipe right → approve / yes / advance
   - Swipe left → skip / no / dismiss
   - Swipe up → open full dossier (modal)
   - Tap → expand inline

6. **Stack:**
   - Next.js 15 App Router
   - Framer Motion para drag/swipe physics
   - shadcn `Card` + custom variants
   - Tailwind v4
   - Mobile-first, max-width 480px
   - Optimistic UI
   - Server Actions para resolve approvals
   - Edge runtime para latencia <100ms

7. **iMessage flow integration:**
   ```
   Concierge daily digest:
   "Spleed daily brief — Tue Jan 15
   
   5 leads need your attention:
   • 2 replies waiting
   • 1 gift approval
   • 1 high-fit lead enriched
   • 1 meeting tomorrow
   
   Tap to swipe through: spleed.ai/d/jhf83k
   Or reply 'inbox' for text-only summary."
   ```

**Anti-patterns:**
- NO requerir login (token URL suficiente)
- NO loading spinners largos
- NO más de 8 cards por brief
- NO desktop-first design

**Dónde modificar:**
- `/apps/web/app/(public)/d/[token]/page.tsx`
- `/apps/web/components/swipe-card.tsx`
- `/packages/db/schema/concierge.ts` — agregar `daily_briefs`, `daily_brief_actions`
- `/packages/agents/concierge/prompt.md` — actualizar digest format
- `/apps/api/routes/brief/[token]/actions.ts`

**Cuándo:** Sprint 9 (frontend).

---

### BACKLOG-010: Tailwind v4 + Next 15 + Turbopack config

**Contexto:** Tailwind v4 cambió a CSS-first config (sin `tailwind.config.js` por default) y usa el plugin `@tailwindcss/postcss`. Next 15 trae Turbopack como dev runtime default. Esta combinación tiene quirks documentados (PostCSS plugin compatibility, content scanning paths, dark mode strategy con `@theme`).

**Qué hacer:** antes de instalar Tailwind v4, verificar docs oficiales actualizadas (Tailwind v4 + Next 15 + Turbopack). Confirmar versión mínima de `@tailwindcss/postcss`, que `@theme` directive en `app/globals.css` corre con HMR, y que tokens del DESIGN.md cargan vía CSS variables. Si Turbopack tiene fricción con PostCSS, fallback a webpack hasta que se estabilice.

**Cuándo:** Sprint 9, antes del primer componente UI.

**Dónde modificar:**
- `/apps/web/postcss.config.mjs`
- `/apps/web/app/globals.css`
- `/apps/web/next.config.ts`

---

## Sprint 12 — Hardening

### BACKLOG-016: Tech debt cleanup — SDK type casts

**Status:** Backlog (Sprint 12 hardening)
**Priority:** LOW — fixes funcionan, son SDK lag temporal
**Origin:** Sprint 3 typecheck fixes (2026-05-12)

**Context:**
3 TypeScript casts en `packages/agents` introducidos durante Sprint 3 por SDK type lag. Los casts son quirúrgicos y safe-at-runtime (zod validation arriba en el código), pero merecen revisión cuando los SDKs actualicen sus types para reflejar lo que ya soportan en runtime.

**Files affected:**
- `packages/agents/src/runtime/prompt-cache.ts` — local `CachedTextBlock` interface en vez de `Anthropic.Messages.TextBlockParam` (que no expone `cache_control` aún en SDK 0.30.1)
- `packages/agents/src/runtime/index.ts` — cast del array `system` al boundary del SDK + cast de `response.usage` para acceder a `cache_read_input_tokens` / `cache_creation_input_tokens`
- `packages/agents/src/workers/define.ts` — cast `as never` en `queue.add(name, validated, opts)` (BullMQ 5.76 `ExtractNameType` / `ExtractDataType` utility types confunden TypeScript a través de nuestro helper genérico `createQueue<T>`)

**Mitigación actual:** zod validation antes de cada cast garantiza shape correcto en runtime. Memoria de proyecto `project_sdk_types_lag_casts.md` documenta cada site con detalle.

**Revisión triggers:**
1. `@anthropic-ai/sdk` actualiza más allá de 0.30.1 → verificar si `cache_control` está exposed en `TextBlockParam` y `cache_read_input_tokens` en `Usage`
2. BullMQ actualiza → verificar si `ExtractDataType` inference mejoró
3. Sprint 12 hardening review (esto)

**Effort estimate:**
- 1-2h investigation + cleanup cuando triggers ocurran
- No urgente, no bloquea nada

**Dónde verificar SDK types al revisar:**
- `node_modules/.bun/@anthropic-ai+sdk@<version>/dist/resources/messages.d.ts`
- `node_modules/.bun/bullmq@<version>/dist/esm/types/...`

---

### BACKLOG-017: Migrate large asset.content (>50KB) to Supabase Storage

**Status:** Backlog (Sprint 12 hardening)
**Priority:** LOW — observability + cost optimization, not correctness
**Origin:** Sprint 4 Decision E (assets inline jsonb for MVP, 2026-05-17)

**Context:**
Sprint 4 stores Composer-generated `assets.content` inline as jsonb (Decision E).
Microsites are ~5-20KB structured JSON — fine inline. But once Composer evolves
to richer assets (audit PDFs with embedded screenshots, ROI calculators with
large datasets, demo_video referencing transcript) some rows may exceed 50KB.
Postgres toasts >2KB jsonb but query patterns still pay for it; CDN-fronted
Supabase Storage scales better.

**Qué hacer:**

1. Add monitoring on `pg_column_size(content)` per row weekly.
2. When ≥10 rows exceed 50KB, plan migration:
   - Add `storage_path text NULL` column on assets.
   - Move `content` body to Supabase Storage at `orgs/{org_id}/assets/{asset_id}.json`.
   - Keep `content` jsonb as `{ kind, version, storagePath, summary }` for fast
     filtering/listing without storage round-trip.
3. Renderer reads `content.storagePath` and fetches the full body lazily.
4. Migration is backwards-compatible: rows below threshold stay inline.

**Triggers de revisión:**
- Postgres TOAST warnings in logs
- Renderer p95 latency > 200ms on lead detail page
- Sprint 12 hardening review

**Effort estimate:** 1-2 días — column add, ingestion helper, renderer fallback, backfill script (chunked).

**Dónde modificar:**
- `packages/db/src/schema/outreach.ts` — `assets.storagePath`
- `packages/agents/composer/` — publish-asset tool (Sprint 7) writes Storage + DB
- `apps/web/app/[slug]/page.tsx` — renderer reads Storage on demand

---

## Phase 2 (post-MVP, sprint 13+)

### BACKLOG-003: Profile pictures en iMessage

**Contexto:** Pfps son útiles para anclar atención en mensajes high-stake (approvals, replies, meetings). Costo en Sendblue MMS y complejidad → Phase 2.

**Qué hacer:**

1. **Apify scrape pfps durante Profiler:**
   - LinkedIn profile picture
   - X avatar (si existe)
   - Storage: `/storage/orgs/{org_id}/leads/{lead_id}/pfp.png`
   - Save URL en `leads.pfp_url`

2. **Concierge integration:**
   - En mensajes high-stake con `lead_id`, incluir pfp como `media_url`
   - SÍ incluir en: `reply_received` (P0), `gift_approval_needed` (P1), `meeting_booked` (P1), `high_fit_lead_enriched` (P1)
   - NO incluir en: `daily_digest` (P2), system notifications, aggregated stats

3. **Cost monitoring:**
   - Track Sendblue MMS costs per org
   - Alert si org excede umbral
   - Failover a SMS sin pfp si cost exceeded

4. **Privacy:**
   - Pfp se borra automático si `lead_id` se elimina (cascade)
   - GDPR: founder puede solicitar borrado total

**Cuándo:** Phase 2 (sprint 13+), post-PMF.

---

### BACKLOG-006: Screenshot enrichment via iMessage

**Contexto:** Founder hace screenshot de un perfil de LinkedIn en su iPhone, lo manda a Spleed. Spleed extrae info via OCR + visión multimodal y enriquece.

**Por qué se difiere a Phase 2:**
- Calidad muy variable: screenshots desenfocados, croppeados, con UI obstructiva
- Risk de mistaken identity es alto (Spleed alucina dossier sobre persona equivocada)
- Necesita eval set para validar accuracy
- En MVP, founder puede mandar URL en lugar de screenshot

**Qué hacer (cuando se implemente):**

1. **Sendblue webhook — recibir media:**
   - Detectar `media_url` en inbound
   - Download imagen a Supabase Storage temp
   - Verificar formato

2. **Concierge intent:**
   - Nuevo: `IMAGE_ENRICHMENT_REQUEST`
   - Trigger: inbound con image attachment

3. **Multi-modal extraction (Claude Sonnet 4.6):**
   - Pasa imagen con prompt:
     - "Identify the LinkedIn/X profile in this screenshot"
     - "Extract: name, role, company, visible bio"
     - "Confidence: 0-1"
   - Si confidence < 0.7, responder: "I'm not sure who this is. URL instead?"

4. **Enrichment trigger:**
   - Si confidence ≥ 0.7, intentar match con LinkedIn search
   - Si match, encolar Profiler
   - Si no, alertar founder

5. **Eval set obligatorio:**
   - 50+ screenshots reales
   - Medir accuracy de identification y dossier downstream
   - Solo lanzar si accuracy > 85%

**Cuándo:** Phase 2, post-PMF + eval validado.

---

### BACKLOG-007: Social scraping selectivo por ICP type

**Contexto:** Para ICP types B2C, creator economy, wellness, lifestyle — Instagram y TikTok son canales business legítimos. Para B2B technical, ruido. Activar opt-in.

**Por qué Phase 2 (no MVP):**
- Apify scraping de IG/TikTok es gris legal — TOS más estrictos
- Risk de "creep factor" si se cita en outreach algo personal de IG
- ROI negativo para 70% de ICPs en MVP cohort
- Compliance enterprise futuro complica

**Qué hacer (cuando se implemente):**

1. **Org config flag:**
   ```sql
   ALTER TABLE orgs ADD COLUMN social_scraping_enabled boolean DEFAULT false;
   ALTER TABLE orgs ADD COLUMN social_scraping_platforms jsonb DEFAULT '[]'::jsonb;
   ```

2. **UI explícita en onboarding (solo si ICP type apropiado):**
   ```
   "Your ICP is active on Instagram and TikTok. Spleed can include 
   public posts and bios from these platforms in lead dossiers.
   
   Note: Spleed scrapes only public, professional content. We avoid 
   personal/family content even if public.
   
   Enable social scraping? [Yes] [No]"
   ```

3. **Profiler tool gating:**
   - Tools `apify_instagram_profile`, `apify_tiktok_profile` solo si `social_scraping_enabled = true`
   - Si false, Profiler no los ve en su tools list

4. **Content filtering rules (CRITICAL):**
   - Solo posts business-related (hashtags professional, captions about work)
   - NUNCA family content (kids, personal celebrations)
   - NUNCA wellness/health vulnerable
   - NUNCA política
   - Si dudas, skip el post

5. **Outreach guardrails:**
   - Composer y Outreach NO pueden citar contenido de IG/TikTok directo
   - Solo se usa para CONTEXT
   - El lead nunca ve "I saw your Instagram post"

**Cuándo:** Phase 2, después de:
1. ≥5 design partners con ICP B2C/creator/wellness
2. Legal review (consultor privacy)
3. Eval que verifica content filtering

**Dónde modificar:**
- `/packages/db/schema/tenant.ts`
- `/apps/web/app/(app)/onboarding/social-step.tsx`
- `/packages/agents/profiler/prompt.md`
- `/packages/agents/composer/prompt.md`

---

### BACKLOG-008: Voice messages bidireccionales

**Status: REJECTED unless evidence emerges.**

**Contexto:** Founder podría dictar comandos a Spleed via voice message en iMessage. Pero:

1. iOS dictation nativo cubre el caso de uso (founder dicta a iMessage, llega texto)
2. Sendblue + Twilio + Deepgram suma $50-100/mes/línea adicional sin valor proporcional
3. Latencia voice→texto→action es 5-10s, peor UX que tipear

**Cuándo reconsiderar:**
- Si ≥3 design partners explícitamente piden voice y demuestran caso de uso
- Si Sendblue agrega voice nativo sin Twilio overhead
- Si latencia mejora dramáticamente con nuevos modelos

---

## Sprint 14+ (post-PMF features)

### ★ BACKLOG-009: Meeting Notes Capture (HIGH VALUE)

**Contexto:** Después del meeting con un lead, founder puede mandar a Spleed:
- Voice memo del meeting (recorded en iPhone)
- Texto con notas
- Screenshot de Zoom transcript
- Video del meeting (si lo grabó)

Spleed transcribe + extrae action items + actualiza dossier del lead + encola followups.

**Por qué es ★ HIGH VALUE:**
- Cierra el loop completo del flow (no solo pre-meeting, también post)
- Founder casi siempre olvida actualizar CRM post-meeting → Spleed lo hace automático
- Action items detectados generan tareas concretas para Outreach o Concierge
- Re-enrichment del dossier con info real del meeting (mucho más valiosa que data scrapeada)
- Fortalece pitch: "Spleed sabe lo que pasó en tu meeting, no solo lo que crees que pasó"

**Qué hacer:**

1. **Concierge intent expansion:**
   - Nuevo: `MEETING_NOTES_CAPTURE`
   - Detectado por:
     - Audio attachment (voice memo)
     - "after my meeting with..." en texto
     - "notes from sarah call:" pattern
     - Forwarded Zoom transcript

2. **Transcription pipeline:**
   - Audio → Deepgram API (recomendado por costo/calidad) o Whisper API
   - Almacena audio + transcripción en Supabase Storage
   - Cost target: <$0.50 por meeting de 30min
   - Cleanup automático del audio después de 90 días (dejar solo transcripción)

3. **Action item extraction (Claude Sonnet 4.6):**
   - Procesa transcripción con prompt:
     ```
     Extract from this meeting transcript:
     - discussed_topics: [array]
     - action_items_for_founder: [array of {item, due_date, priority}]
     - action_items_for_lead: [array of {item, due_date}]
     - sentiment: positive | neutral | negative | mixed
     - next_steps_proposed: string
     - key_quotes: [array of {quote, speaker, context}]
     - pricing_discussed: object (if any)
     - objections_raised: [array]
     - decision_makers_mentioned: [array of names + roles]
     - timeline_indicators: string (when do they want to start?)
     ```

4. **Schema:**
   ```sql
   CREATE TABLE lead_meetings (
     id uuid PRIMARY KEY,
     lead_id uuid NOT NULL REFERENCES leads(id),
     org_id uuid NOT NULL REFERENCES orgs(id),
     occurred_at timestamptz NOT NULL,
     duration_minutes int,
     audio_url text,
     transcription text,
     extracted_data jsonb NOT NULL,
     followup_required boolean DEFAULT false,
     followup_completed_at timestamptz,
     created_at timestamptz DEFAULT now()
   );
   
   ALTER TABLE leads ADD COLUMN last_meeting_at timestamptz;
   ALTER TABLE leads ADD COLUMN meetings_count int DEFAULT 0;
   ```

5. **Lead dossier update:**
   - Agregar sección `meeting_history` al dossier
   - Cada meeting es row en `lead_meetings`
   - Updates dossier confidence (real conversation > scraped data)
   - Cita real quotes del meeting en outreach futuro (mucho más poderoso que data pública)

6. **Automatic follow-up trigger:**
   - Si action items para founder detectados → crea tasks
   - Si action items para lead detectados → Concierge propone followup message
   - Si "send proposal next week" detectado → schedule reminder
   - Si lead expresó objeción → flag para founder review

7. **UX flow ejemplo:**
   ```
   Founder iMessage [voice memo, 15s]:
   "Just finished with Sarah. We agreed on $200/mo per seat, 
   she wants to start with 5 users, asked me to send the 
   contract by Thursday."
   
   Concierge: "Got it. Processing meeting notes..."
   
   [30s después]
   
   Concierge: "Meeting captured for Sarah Chen at Acme:
   
   Sentiment: positive, deal-ready
   Pricing agreed: $200/mo per seat
   Initial seats: 5
   Action item for you: send contract by Thursday
   
   I'll remind you Wednesday 4pm to send.
   Want me to draft the contract email now? YES / NO"
   ```

8. **Privacy considerations (CRITICAL):**
   - Audio del meeting puede contener info sensible del lead
   - Founder es responsable legal del consentimiento de grabación
   - Spleed disclaimer al feature activation: "You are responsible for obtaining consent before recording meetings."
   - Audio se borra después de 90 días automático
   - Transcripción permanece para referencia
   - Founder puede borrar todo en cualquier momento

9. **Integraciones futuras (sprint 15+):**
   - Zoom integration (auto-pull transcripts post-meeting)
   - Otter.ai integration
   - Google Meet recordings
   - Granola export

**Dónde modificar (much):**
- `/packages/db/schema/leads.ts` — `lead_meetings`, columnas a `leads`
- `/packages/agents/concierge/prompt.md` — intent + handler
- `/packages/agents/concierge/handlers/meeting-notes.ts` — handler dedicado
- `/packages/integrations/deepgram/client.ts` — transcription
- `/packages/integrations/zoom/client.ts` — Phase 3 integration
- `/apps/web/app/(app)/leads/[id]/meetings/` — UI for meeting history

**Cuándo:** Sprint 14+, después de validar core MVP. Es el feature más diferenciador post-MVP.

**Estimate:** Sprint dedicado completo (1-2 semanas). Justifica el effort por su impacto en retention y pitch.

---

### ★ BACKLOG-011: LinkedIn engagement capture + co-pilot publishing

**Status:** Backlog (post-MVP, target Sprint 14-16)
**Priority:** ⭐ HIGH VALUE — potential differentiator and economic shift
**Origin:** Founder ideation, Sprint 1 cierre (2026-05-11)

**Context:**
Outbound puro está saturado. Founders pre-seed/seed reciben docenas de DMs LinkedIn cold por semana. Conversion rate típica: 1-3%. LinkedIn inbound (engagement de posts publicados por el founder) es la otra cara: los que dan like/comment son inbound warm leads con interés ya demostrado.

**Idea:**
Spleed extiende su agentic loop a LinkedIn:
1. Founder publica posts en LinkedIn (manual o asistido por Spleed)
2. Spleed monitorea engagement (likes, comments, shares, profile views)
3. Profiler agent enriquece cada engager
4. Scout filtra por fit con ICP del founder
5. Concierge presenta vía iMessage: "5 nuevos engagers en tu último post. 3 son tu ICP."
6. Outreach Operator drafta DMs personalizados de follow-up
7. Founder aprueba vía iMessage, envío

**Phased Implementation:**

Phase 1 — Engagement-only capture (Sprint 14, ~2 weeks)
- Founder publica posts manualmente (Spleed NO publica)
- Spleed monitorea engagement vía LinkedIn cookies/Apify
- Profiler enriquece a cada engager (cross-channel)
- Scout filtra por fit con ICP
- Concierge envía resumen iMessage
- Outreach Operator drafta DMs follow-up
- Valor: 80% del impacto con 20% del riesgo

Phase 2 — Co-pilot publishing (Sprint 16, ~2 weeks)
- Composer analiza voice del founder (últimos 30 posts)
- Composer propone post drafts basados en ICP pain points + trending topics
- Founder edita + publica desde su cuenta nativa
- Phase 1 captura engagement automáticamente

Phase 3 — Full agentic publishing (Phase 3 producto, post-Series A)
- Spleed publica autónomamente con approval iMessage screenshot
- Riesgo TOS asumido conscientemente
- Tier pricing premium ($1,500+/mes)
- Requires legal review

**Technical challenges:**
1. LinkedIn API restrictiva (Marketing API requiere 3-6 sem approval). Likely path: scraping con cookies del usuario, zona gris TOS. Decisión ética requerida pre-implementation.
2. Voice/tone del founder crítico. Requiere fine-tuning con samples del founder.
3. Identificar "comments relevantes" no trivial. Costo computacional alto.
4. LinkedIn rate limits / detection. Rate limit interno necesario.

**Mapping a agents existentes (no requiere séptimo agent):**
- Composer → extends to LinkedIn post drafts
- Scout → extends to engagement signals as fit indicator
- Profiler → enriches engagers same as cold leads
- Outreach Operator → adds LinkedIn DM channel
- Concierge → approval flow para posts + DMs

**Risks:**
- LinkedIn TOS violation puede resultar en suspension de cuenta del founder
- Daño reputacional si se pierde cuenta de design partner
- Decisión: nunca tomar riesgo TOS sin opt-in explícito del founder

**Dependencies:**
- Sprint 1-12 core MVP completo
- 5-10 design partners activos validando core loop
- Decisión ética sobre LinkedIn scraping vs API oficial

**Estimated effort:**
- Phase 1: ~2 weeks (1 sprint)
- Phase 2: ~2 weeks (1 sprint)
- Phase 3: ~3-4 weeks (1.5 sprints)
- Total: 5-7 weeks de capacidad de engineering

---

## Business & positioning (ongoing review)

### BACKLOG-012: Pricing & unit economics review + Sendblue alternativas

**Status:** Backlog (active monitoring, decision points pre-defined)
**Priority:** HIGH — affects entire business model
**Origin:** Founder + Claude analysis, Sprint 1 cierre (2026-05-11)

**Context:**
Unit economics actual:
- Founder tier ($497/mes annual): COGS $159.50, gross margin 68%
- Team tier ($1,497/mes annual propuesto): COGS $622, gross margin 58%
- Sendblue es 63% del COGS Founder tier ($100/línea)

**Sendblue alternativas evaluadas:**

| Provider | Pricing | Track record | SOC 2 | Decisión |
|---|---|---|---|---|
| **Sendblue** AI Agent | $100/línea/mes | 5+ años, miles de clientes | ✅ Sí | ✅ Mantener |
| Blooio Starter | $89/mes | ~1 año | ❌ No | Rechazado (shared number rompe UX) |
| Blooio Commercial | $289/mes | ~1 año | ❌ No | Rechazado (más caro que Sendblue, sin SOC 2) |
| Linq | $500+ setup | ~1 año | ❌ No | Rechazado (sales call required) |
| LoopMessage | $30-100 con add-ons | Limited | ❌ No | Rechazado (sin compliance) |
| Tuco AI | $149-299/mes + $335 setup | Limited | ❌ No | Rechazado (Mac Mini per customer no escala) |
| BlueBubbles (OSS) | $0 | OSS community | ❌ No | Rechazado (Mac físico per founder, no viable SaaS) |

**Decisión final:** Sendblue por SOC 2 compliance, track record, y rate limits manageable para use case Spleed (200 follow-up contacts/día por línea, Spleed usa ~7/día).

**Sendblue caveat detectado:**
Plan AI Agent ($100/mes) está pensado para AI agents conversacionales/inbound. Outbound proactivo a cold leads técnicamente requiere "Blue Ocean plan" (custom pricing). En la práctica, mientras estamos bajo rate limits (200 follow-ups/día/línea), no es issue. Monitorear cuando founders escalen leads/mes.

**Timing de negociación Sendblue (volume + annual discount):**

| Etapa | Founders activos | Target/línea | Probabilidad éxito |
|---|---|---|---|
| Punto 1 | 15-20 | $80-85 | 50-70% |
| Punto 2 | 30-50 | $65-70 | 80-90% |
| Punto 3 | 100+ | $50-60 | Enterprise contract |

**Acción recomendada:** Negociar a partir de 15 founders activos (probablemente Sprint 14-18). NO antes — sin leverage. NO después — pierdes savings cada mes.

**Pricing validation framework:**

Validar willingness-to-pay $497/mes con design partners primeros:
1. Onboard 5 design partners con descuento friends&family ($199/mes los primeros 3 meses)
2. Si convierten a $497 después del descuento → pricing funciona
3. Si churnean por precio → tienes datos reales para decidir Lite vs price drop

**No deshacer pricing actual antes de validar.**

---

### BACKLOG-013: Lite tier consideration (DEFERRED)

**Status:** Deferred — analyzed and consciously decided NOT to launch now
**Priority:** Low (reconsider only after MVP validation)
**Origin:** Founder question, Sprint 1 cierre (2026-05-11)

**Pregunta original:**
¿Lanzar tier Lite ($99/mes) con features reducidas para reducir friction de venta y aumentar volume de design partners?

**Decisión: NO lanzar Lite tier ahora.**

**Razones del NO:**

1. **Lite mata el core differentiator.** Sin iMessage Concierge (Sendblue $100/mes incluido), Spleed sería "outbound automation with personalization" — commoditizado. Founders que prueban Lite NO experimentan el wow moment real del producto.

2. **Margin alto no compensa si destruye funnel premium.** 100 Lite × $99 = $9,900/mes vs 100 Founder × $497 = $49,700/mes. Mismo CAC, 5x más revenue con Founder tier.

3. **Lite atrae al ICP equivocado.** Founders con $10K+ MRR (tu ICP) NO son price-sensitive a $99 vs $497. Founders sin MRR (idea-stage) sí — pero su problema real es product-market fit, no outbound. Churn esperado.

4. **Pricing tier proliferation kills focus.** Cada tier requiere product decisions, marketing copy, onboarding distinto. Para founder solo, fragmentar atención cuando deberías concentrarla en tier principal.

5. **Solucionas problema percibido, no real.** No has validado que $497 sea barrera. Validar primero, ajustar después.

**Plan alternativo:**

- MVP launch con SOLO Founder tier ($497/mes annual)
- Free trial 14-21 días para reducir friction sin bajar precio
- Si después de 3-6 meses con design partners hay resistencia clara a precio:
  - Considerar Founder tier más bajo ($297/mes — no $99, mantiene iMessage)
  - O "Spleed Outbound" como producto separado sin iMessage (target ICP distinto)

**Reconsider trigger:** 6 meses post-MVP launch con datos reales de design partners.

---

### BACKLOG-014: Competitive positioning — iMessage-native space

**Status:** Backlog (active research, refresh quarterly)
**Priority:** Medium — informs marketing + positioning
**Origin:** Competitive analysis Sprint 1 cierre (2026-05-11)

**Hallazgo principal:**
El espacio iMessage-native para B2B founder sales está prácticamente vacío. Spleed sería primer iMessage-native sales tool específicamente para founders.

**Landscape analizado:**

**Categoría A — iMessage-native:**
- **Ditto** ($9.2M seed, 42K usuarios, 25% organic growth) → consumer dating, iMessage-only UX. Valida tesis iMessage como interfaz primaria.
- **Tuco AI** ($149-299/mes + $335 setup) → general B2B messaging, Mac Mini per customer, no founder-specific.
- **Spleed** → único iMessage-native para B2B founder sales.

**Categoría B — AI SDRs tradicionales (no iMessage):**
- 17+ tools revisados (AiSDR, Artisan, 11x.ai, Coldreach, Salesforge, Amplemarket, Landbase, Apollo, Clay, etc.)
- Todos usan email + LinkedIn + occasional SMS/phone
- Dashboard-heavy UX
- Pricing $79-3,960/user/mes
- Ninguno usa iMessage como canal primario

**Categoría C — CRMs + iMessage como add-on:**
- GoHighLevel + Sendblue
- HubSpot + Sendblue
- Salesforce + Sendblue
- iMessage es side channel, no producto core

**Categoría D — AI-native revenue platforms (competidores directos):**
- **Monaco** (monaco.com) — "The first revenue engine for startups"
  - Inversores: Garry Tan (YC CEO), Peter Thiel (Founders Fund), Ryan Petersen (Flexport founder)
  - Posicionamiento: All-in-one CRM replacement + agentic platform
  - Features: TAM builder, outbound automation, pipeline management, call recording, sequences, CRO Copilot, forward-deployed sales exec
  - Onboarding: white-glove + human sales executive
  - Pricing: hidden (request demo, probable $1,000-5,000+/mes)
  - Target: "startups" (general, no founder-specific)
  - Detectado: 2026-05-11

**Análisis competitivo Monaco vs Spleed:**

Overlap real:
- AI agents para sales automation
- Multi-tenant SaaS for founders
- Outbound automation + pipeline

Spleed differentiators NO replicables fácilmente:
- iMessage-native interface (Monaco es dashboard-first)
- Integrated gifting via Stripe Issuing (Monaco no menciona)
- Personalized microsites per lead (Monaco no tiene)
- Approval flow via iMessage (Monaco autonomous-by-default)
- Founder-specific niche con $10K+ MRR ICP (Monaco generic)

Monaco strengths que Spleed no replica:
- Call recording + meeting capture
- CRM completo (Spleed es complementario, no replacement)
- Forward-deployed sales executive (humanos en the loop)
- Network YC + Thiel + Petersen distribution

**Validación del mercado:**
- Monaco existiendo VALIDA que el problema founder-led sales es real y monetizable
- VALIDA que AI agents > CRMs tradicionales como approach
- VALIDA que founders están dispuestos a pagar para resolver esto
- NO valida que el specific approach de Spleed (iMessage-native + gifting + microsites) gane

**Implicación estratégica (vs Monaco):**
- No competir feature-by-feature con Monaco (perdería war de capital)
- Mantener focus en diferenciadores únicos
- Acelerar Sprint 5-7 (los visibles del producto) para tener demo competitivo antes que Monaco se establezca enterprise
- Cuando lleguen design partners (Sprint 12+), posicionar EXPLICITLY: "Monaco resuelve CRM replacement, Spleed resuelve founder-led sales sin SDR en tu iMessage"
- NUNCA mencionar Monaco proactivamente en chats con makers/customers

**Implicación estratégica:**
1. Ventana competitiva 6-18 meses antes que alguien más vea el espacio
2. Posicionamiento "iMessage-native sales tool" debe ancarse antes que alguien más reclame esa posición
3. Founding manifesto sugerido: "Tu próximo lead no está en un dashboard. Está en tu iMessage."

**Threats:**
- Ditto pivot a B2B (improbable, su brand es consumer)
- Tuco AI especializa en founder sales (posible, requires refocus)
- Apollo/Clay agregan iMessage native (conflicts con su modelo dashboard, más probable que agreguen como otro canal)
- Nueva startup similar (posible, 6-18 meses ventana)

**Acción recomendada:**
1. Refresh este análisis cada Q (cambios competitivos rápidos en AI sales)
2. Cuando salgas a design partners, posicionar agresivamente como "iMessage-native"
3. Monitorear Ditto roadmap (profesional networking expansion mencionada)

---

### BACKLOG-015: Meeting note-taker propio + integrations layer

**Status:** Backlog (post-MVP, target Sprint 15-18)
**Priority:** MEDIUM — extends Spleed surface area beyond cold outreach
**Origin:** Founder ideation (2026-05-11), Sprint 2 cierre

**Context:**
Spleed actualmente captura datos de leads pre-meeting (Scout + Profiler) y post-meeting (manual feedback del founder). Hay gap: la meeting misma NO es capturada por Spleed. El founder agenda call con lead via Spleed, pero el contenido de la call vive en notas dispersas o no existe en ningún sistema accesible al producto.

**Idea — Meeting note-taker:**
Bot tipo Otter.ai/Granola/Fireflies pero integrado al pipeline de Spleed:
1. Founder agenda call con lead via Spleed (Sprint 7-8 flow)
2. Spleed manda calendar invite con bot incluido (Google Meet, Zoom)
3. Bot transcribe + identifica speakers
4. Concierge agent analiza transcript post-meeting:
   - Pains nuevos mencionados → update lead_dossier
   - Objections → flag para Outreach Operator
   - Action items para founder → iMessage reminder
   - Next steps → update lead.status (engaged → tracking)
5. Founder recibe resumen via iMessage 5 min post-meeting

**Idea — Integrations layer:**
Bidirectional sync con tools que el founder ya usa:
- **HubSpot** (sync leads + activities; deferir hasta confirmar que NO son competencia directa según pricing/positioning de design partners)
- **Notion** (sync lead notes + dossiers as Notion pages para shareability)
- **Slack** (post lead updates a #sales o canal designated)
- **Google Calendar** (ya integrado para meetings Sprint 7-8)
- **Linear / Asana** (track action items post-meeting)

**Why phased:**
- Phase 1: Meeting note-taker (Sprint 15) — high-value standalone
- Phase 2: Integrations layer abstraction (Sprint 16) — agnostic API
- Phase 3: Specific integrations on-demand (Sprint 17+) — Notion → Slack → HubSpot orden de friction

**Competitive comparison:**
- Otter.ai/Fireflies/Granola: standalone note-takers, no integran al pipeline de sales
- Gong/Chorus: enterprise sales coaching, $500-2K/mes/seat, no founder-fit
- Spleed differentiator: note-taker como parte del agentic loop, Concierge agent extrae insights y actúa automáticamente

**Risks:**
- Meeting bots requieren consent legal (recording laws varían por estado/país)
- Integration maintenance overhead (cada API cambia, breaks)
- Scope creep si tratamos de matchear feature-completeness de Otter

**Dependencies:**
- Sprint 5-12 MVP completo
- Validation con design partners que meeting capture es valued
- Google Calendar OAuth (Sprint 7-8)
- Posiblemente Recall.ai SDK o similar para bot infrastructure

**Estimated effort:**
- Phase 1: ~3 weeks (1.5 sprints)
- Phase 2: ~2 weeks
- Phase 3: depends on número de integrations (1 week cada)

---

## Sprint 7-8 — Acceleration items

### BACKLOG-018: Lead ingest manual (CSV/Excel/Apollo export)

**Status:** Backlog, accelerated Sprint 7-8 (was Sprint 13-14)
**Priority:** ⭐ HIGH — expands product surface significantly + required by design partner Grupo500
**Origin:** Founder ideation 2026-05-17, refined by Sebastián (Grupo500) use case 2026-05-18

**Context:**
Founders pueden cargar listas propias de leads (de eventos, network, exports CRMs viejos, base de datos existente). Spleed las enriquece + las mete al pipeline. Acelerado de Sprint 13-14 a Sprint 7-8 por design partner Grupo500 (10K colegios en base de datos propia).

**Scope MVP:**
- CSV/Excel upload via dashboard
- Column mapping (email, name, company, etc.)
- Dedup logic (existing slug + email + linkedin)
- Bulk enrichment via Profiler
- Preview/confirmation antes de procesar
- Error handling (rows mal formados)

**Why Sprint 7-8 (not Sprint 6):**
- Profiler primero valida que enrichment funciona
- Sebastián no necesita producto en 60 días, concierge mientras tanto
- Sprint 7-8 alinea con Composer ready (end-to-end coherente)

**Effort estimate:** ~1.5 sprints

---

## Sprint 9-10 — Dashboard MVP shell

### BACKLOG-019: Dashboard MVP shell — acelerado a Sprint 9-10

**Status:** Roadmap update — from "Sprint 9-12 nice-to-have" to "Sprint 9-10 must-have"
**Priority:** ⭐ HIGH
**Origin:** Founder feedback 2026-05-17 — "leads no deben desaparecer en el chat, deben tener home visible"

**Scope:**
Sprint 9: Auth UI (Supabase magic link) + kanban view leads + lead detail view (dossier + outreach history + tracking timeline) + basic navigation

Sprint 10: ICP setup form CRUD + integrations setup (Apollo, Apify, Sendblue OAuth) + onboarding flow + empty/loading states

Sprint 11-12 (was 9-12 vague): Dashboard polish + analytics + settings + team management

**Refined value prop:**
"Spleed lives in your iMessage for moments that matter. Your leads + pipeline live in your dashboard for when you need depth."

iMessage = primary interaction channel.
Dashboard = setup + visibility + reference.

---

## Sprint 11-12 — Phase 1 expanded features

### BACKLOG-022: Multi-recipient notifications (cofounder/team)

**Status:** Sprint 11-12 (within Phase 1 expanded para teams chicos 2-5 personas)
**Priority:** MEDIUM
**Origin:** Founder refinement 2026-05-18 — ICP v2 includes team size 1-15

**Scope:** Cuando founder org tiene 2+ members con roles owner/admin, decisions críticas se broadcastean a todos. Multi-recipient iMessage (todos members con Sendblue line) + dashboard notifications.

**Critical decisions to make Sprint 11:**
- Routing: ¿quién aprueba si owner y admin son distintos?
- Conflict resolution: ¿qué si owner aprueba y admin rechaza?
- Notification frequency: ¿all decisions or only critical?

**Effort estimate:** ~1 sprint (notification routing + multi-tenant permissions extension)

---

## Sprint 14-15 — Strategic validation research

### BACKLOG-023: Social ring routing — research spike

**Status:** Backlog research/validation (Sprint 14-15)
**Priority:** Strategic vision — high if validates, no commit yet
**Origin:** Founder strategic insight 2026-05-17 (Zolvo factoring lenders example)

**Hypothesis:** For ICPs where decision maker has low digital footprint, agents that route outreach via "closest person in network" (family, alumni, ex-colleagues, peers) deliver higher conversion than direct outreach.

**Research spike scope:**
- Interview 5-10 founders (mix of design partners + cold)
- Questions: ¿How many decision makers in your ICP have low digital footprint? Do you value warm intro via network vs cold outreach? Would you be comfortable with agents reaching out to your network proxies?
- Validate ethics/TOS implications (LinkedIn aggressive graph mapping)
- Deliverable: decision document — proceed/defer/abandon

**Effort:** ~1 week research + interviews

**If validates → Sprint 18-24** implementación as Phase 2 feature (Level 3 differentiator vs Monaco/Apollo).

---

## Sprint 18+ — Contingent on validation

### BACKLOG-020: Slack integration — team visibility

**Status:** Deferred (post-MVP, Sprint 18+ contingent on validation)
**Priority:** Low until validation
**Origin:** Founder ideation 2026-05-17, refined 2026-05-18 with ICP v2 (team size 1-15)

**Scope:** Postear updates de leads importantes a #sales channel designated. Útil para founders con cofounders/team chico que necesitan team coordination.

**Trigger conditions (ALL must be met before building):**
- 30+ founders en Spleed activos
- >50% de esos founders tienen 2+ team members en su org
- Survey muestra que founders piden Slack team visibility (no hipotético)

**Alternative considered:** Multi-recipient iMessage (BACKLOG-022). Validar primero antes de Slack.

**Effort estimate:** ~3 weeks (Slack OAuth + webhook + channel routing + permissions)

---

### BACKLOG-021: Kimi WebBridge browser tool evaluation

**Status:** Deferred (Sprint 18+ or never)
**Priority:** Low — research only
**Origin:** Founder ideation 2026-05-17 (Kimi WebBridge lanzado 4 días antes)

**Context:** Moonshot AI lanzó Kimi WebBridge, browser extension local-first via Chrome DevTools Protocol. Alternativa potencial al agent-browser de Vercel (decidido Sprint 6).

**Analysis:** Kimi WebBridge NOT fit para Spleed actual:
- Too new (4 días lanzado, maturity unknown)
- Client-side architecture (Spleed necesita server-side multi-tenant)
- Model lock-in con Kimi K2 (Spleed usa Anthropic Teams)
- Local-first vs SaaS multi-tenant fundamentalmente distinto

**Re-evaluation triggers:**
- agent-browser Vercel se vuelve restrictive
- Anthropic costs balloon (Kimi K2 más barato)
- Spleed adds Chrome extension feature para founders

**Action:** NO adoption en current roadmap.

---

## Concierge service & design partners (active now)

### BACKLOG-024: Concierge service offering

**Status:** Process documentation (active now for design partners)
**Priority:** ⭐ HIGH — revenue + validation mechanism while building
**Origin:** Strategic decision 2026-05-18, capacity validated 2026-05-19 via realistic cost analysis

**Context:**
Mientras Spleed producto se construye (Sprints 5-12), ofrecer "concierge service" donde Felipe + Claude API hace manualmente para design partners lo que el producto va a automatizar.

**Pricing structure:**
- $2,000/mes durante 3 meses (concierge phase)
- Migration a producto cuando ready: $1,500/mes (vs $497 pricing público) por ser design partner
- 12 meses guaranteed at $1,500
- 6 meses producto bonus al final

**Scope concierge:**
- Manual lead enrichment (Felipe + Claude API)
- Personalized email outreach (Felipe writes, Claude assists)
- Meeting scheduling via Calendly direct
- Reporting weekly (meetings agendadas, conversion rates)

**Capacity limit (REVISED 2026-05-19):**
Max 1-2 concierge customers simultaneous, NOT 3 as originally estimated. Realistic time analysis showed ~30-42 hrs/mes per concierge customer. With 3+ customers, building product becomes impossible. Felipe must default to 1 concierge customer focused plus light engagement con resto de design partners.

**Cost economics validated:**
- Variable cost per customer: ~$80-110/mes (Claude API + Apify + Apollo) with prompt caching enabled
- Fixed infra base: $400-1,300/mes (Supabase + Vercel + Railway + Sendblue + Resend + warmup tools)
- Gross profit per concierge customer at $2K: ~$1,590/mes
- Effective rate per Felipe hour: ~$53/hr (rentable financially, sub-optimal estratégicamente vs building product)

**Pipeline tracking en este BACKLOG:**
- BACKLOG-025: Sebastián / Grupo500 (confirmed)
- BACKLOG-026: Zolvo (prospective, Phase 2 contingent)
- Other prospects (30X, CTW, Bodytech) tracked in local document Spleed_DesignPartners_Tracking.pdf (not git, Felipe-only)

---

### BACKLOG-025: Design partner #1 — Sebastián / Grupo500

**Status:** Confirmed design partner, concierge phase 1 negotiation pending
**Priority:** ⭐ HIGH
**Origin:** Lead validation 2026-05-18

**Context:**
Sebastián, dueño de Grupo500. Vende cursos preICFES a colegios Colombia. Base 10K colegios, outreach manual actual, problema llegando a decision makers (secretarias responden, no rectores).

**ICP fit:**
- Founder doing founder-led sales ✓
- Team size small ✓
- B2B with sophisticated sales motion ✓
- Lead universe identifiable (10K colegios) ✓
- Industry: educación (NOT SaaS, but matches ICP v2 horizontal) ✓

**Proposed offering:** Concierge $2K/mes × 3 meses + migration to product

**Tracking learnings:**
- What works in educational B2B vs SaaS
- ICFES data integration patterns (vertical-specific avoid for product, customer provides data)
- Decision maker access via personalization (validates Spleed core thesis)
- Conversion rates from concierge work

**Next steps:**
- 30-min discovery call to formalize partnership
- Pitch $2K/mes concierge structure
- If accepted: start concierge work immediately, parallel to Sprint 5+ product work

---

### BACKLOG-026: Design partner #2 prospective — Zolvo

**Status:** Prospective, Phase 2 dependent
**Priority:** MEDIUM (warm lead, timing-dependent)
**Origin:** Lead conversation 2026-05-17

**Context:**
Zolvo (zolvo.com) — Backoffice software para factoring lenders. Dispuesto a "grow with me" as design partner. Use case heavily dependent on social ring routing (decision makers low digital footprint en factoring industry).

**ICP fit:**
- Founder doing founder-led sales (likely) ✓
- B2B with sophisticated sales motion ✓
- Industry: fintech traditional (NOT SaaS, matches ICP v2 horizontal) ✓
- Lead universe: limited TAM but identifiable ✓
- KEY PAIN: requires social ring routing (Phase 2 feature)

**Two options to present:**

Option A: Wait for Phase 2 (Sprint 14+)
- Spleed builds social ring routing post-validation (BACKLOG-023)
- Zolvo is first customer when ready
- 6+ months wait time

Option B: Onboard Phase 1 with direct outreach (no social ring yet)
- $1,500/mes from day 1
- Workable but less optimal for their case
- Migration to social ring routing automatic when feature ships

**Mariana (GTM) validation 2026-05-19:**
Confirmed patterns matching Spleed thesis: cold outreach mostly "opened sin respuesta", LinkedIn connect-first pattern works, sales cycle 2-3 months, TTV pilot 1 month, no structured follow-ups. Information valuable independent of partnership outcome.

**Next steps:**
- Honest conversation to determine Zolvo timing flexibility
- Pitch both options, let them choose
- If Option A: track interest, re-engage Sprint 14
- If Option B: onboard now as design partner #2

---

## Sprint 7-8 — BYOK + Slack + Hermes lightweight (post Houston event 2026-05-20)

### BACKLOG-027: BYOK del LLM (Bring Your Own Key)

**Status:** Committed for Sprint 7 implementation
**Priority:** ⭐⭐ CRITICAL — pricing differentiator + unit economics
**Origin:** Felipe Salinas / Houston.ai event observation 2026-05-19, validated against ICP v2 (founders B2B tech-savvy ya tienen Claude Teams/Pro)

**Hypothesis:**
Tenants conectan su propia cuenta Claude/OpenAI via OAuth. Spleed orquesta sus agents sobre el LLM del tenant. Pricing más bajo ($297-497/mes vs $497-1500/mes managed), margins más altos (75-79% vs 20-37%).

**Why Sprint 7 (no Sprint 13-14 como original):**
- Vault per-tenant Sprint 1 ya soporta secrets per-user
- 5 design partners YA tienen Claude Teams/Pro (validado mental)
- Margins desde día 1 vs después
- Pricing más accesible facilita conversion design partners US

**Validation needed (Sprint 6 antes de implementation):**
- Confirmar con Anthropic si OAuth público está disponible para third-party apps, O si require enterprise tier
- Si solo enterprise: fallback a API key paste manual con UX decente
- Test con Sebastián (educación) si está dispuesto a "conectar Claude"

**Sprint 7 implementation:**
- Anthropic OAuth flow (research first)
- Token storage encrypted en Vault (existing infrastructure)
- Routing logic: use tenant's key OR Spleed's key (tier-based)
- Rate limit handling graceful (cuando user hittea su limit)
- Error UX (user's key invalid → re-auth flow)
- BYOK toggle en onboarding

**Risks:**
- Anthropic puede NO ofrecer OAuth público → friction mayor
- Rate limits del tenant pueden hacer producto sentirse roto
- Multi-tenant complexity (secret management per user)

**Cost economics validated 2026-05-19:**
- Sin BYOK: $86/mes Claude API per customer (Spleed paga)
- Con BYOK: $0/mes (tenant paga en su plan Claude Teams)
- Margin improvement: 20% → 37% solo BYOK, 20% → 75-79% BYOK + Slack combinados

---

### BACKLOG-028: Channel strategy MVP — Slack primary, iMessage descartado

**Status:** Committed for Sprint 7 implementation
**Priority:** ⭐⭐ CRITICAL — affects unit economics + ICP fit
**Origin:** Felipe re-evaluation 2026-05-19 post Houston.ai event

**Decision:**
Slack como channel primario MVP. iMessage (Sendblue) DESCARTADO. WhatsApp Business deferred a Phase 2 (Sprint 13-14).

**Justification:**
- Costo: Slack $0 vs Sendblue $200-700/mes per customer
- Setup complexity: Slack OAuth 1 día vs WhatsApp Business 1-2 semanas verificación Meta
- Design partner relationship: Felipe tiene cercanía 1:1 con los 5 iniciales → puede compensar channel friction con personal nudge

**Asunción explícita:**
Design partners van a usar Slack daily a pesar de que algunos NO son Slack-native. Cercanía personal compensa engagement friction durante design partner phase.

**Trade-off accepted:**
Possible engagement sub-óptimo vs WhatsApp en algunos design partners. OK durante MVP porque relación 1:1 permite manual nudging.

**Re-evaluation triggers (Phase 2 → WhatsApp):**
- Customers nuevos (no design partners) reportan baja engagement
- >30% missed approvals attributable to channel friction
- LatAm-heavy customers solicitan WhatsApp específico
- Onboarding completion rate <70% por friction Slack setup

**Sprint 7 implementation:**
- Slack OAuth flow (workspace + bot install)
- Bot messages para approvals (interactive blocks con buttons)
- Channel routing: por default DM al founder
- Notification preferences (urgency thresholds)
- Webhook handling para responses

**WhatsApp Business path (Phase 2 / Sprint 13-14):**
- Meta Business verification (proceso 1-2 semanas, paralelizable)
- Interactive messages para approvals
- Multi-channel routing: user choice Slack OR WhatsApp

---

### BACKLOG-029: Spleed positioning consolidado

**Status:** Strategic positioning document (active 2026-05-20)
**Priority:** ⭐ HIGH — affects all marketing + sales + roadmap
**Origin:** Felipe reflection post Houston.ai event + sleep 2026-05-19/20

**Context:**
Re-articulación de propuesta de valor de Spleed. NO es pivot. ES refinamiento de positioning con framing más fuerte.

**Old positioning (deprecated):**
"Spleed is a 6-agent system that executes founder-led sales for you."

**New positioning:**
"Spleed is the orchestration + learning infrastructure that turns your standard Claude/GPT into a sales system that improves over time, specific to your tenant."

**Three pillars:**
1. **Orchestration** — 6 agents coordinated, state-managed, multi-tenant
2. **Tools + integraciones** — Apollo, Apify, Slack, browser, gifting managed for you
3. **Learning loops (Hermes)** — tenant feedback continuously improves master prompts

**De-emphasized:**
- Microsites as differentiator (now optional feature, BACKLOG-031)
- "6 agents" as marketing pitch (technical detail, not lead message)
- "iMessage as channel" (Slack primary MVP, BACKLOG-028)

**Re-emphasized:**
- Quality of opening message (BACKLOG-031)
- Scout ↔ Profiler ↔ Composer integration
- Hermes learning per-tenant (BACKLOG-030, BACKLOG-032)
- BYOK as accessibility lever (BACKLOG-027)

**Marketing messages by audience:**
- Customer founder: "Tu Claude responde preguntas. El Spleed-Claude vende para vos."
- Investor: "Orchestration + learning sobre BYOK LLM. Data flywheel per-tenant es el moat."
- Peer founder técnico: "Multi-tenant agent orchestration con feedback loops sobre LLM BYOK."
- 30-second pitch: "Outbound que aprende tu voz cada semana."

---

### BACKLOG-030: Hermes architecture — Learning loops per-tenant

**Status:** Architectural design (Sprint 8 lightweight, Sprint 12+ full)
**Priority:** ⭐⭐ CRITICAL — defines product moat
**Origin:** Felipe strategic insight 2026-05-20 post Houston.ai

**Hypothesis:**
Each tenant gets a personalized "Hermes layer" that observes their approvals, edits, rejections, and outcomes. Hermes updates master prompts for that tenant over time.

**Data captured per tenant:**
- Drafts approved as-is (positive pattern)
- Drafts edited before send (delta = what to adjust)
- Drafts rejected (negative pattern)
- Sent emails → response rates (success metric)
- Sent emails → meeting booked (conversion metric)

**Pattern accumulation per tenant:**
- Hook types that convert (industry-specific)
- Email length sweet spot
- Tone calibration per ICP
- Subject line patterns that get opens
- Best times to send per audience

**Why this is the moat:**
- After 90 days, tenant's Spleed-Claude meaningfully better than raw Claude
- After 180 days, switching cost is real (lose all learned patterns)
- Defendible vía data flywheel — más uso = mejor producto = más retention

**Implementation path:**
- Sprint 8 lightweight (BACKLOG-032): feedback capture only, no pattern extraction
- Sprint 12+ full (Phase 2): pattern extraction + prompt evolution + A/B testing

---

### BACKLOG-031: Opening Message Quality — el momento de la verdad

**Status:** Sprint 7 focus area (Composer)
**Priority:** ⭐⭐ HIGH — primary product value
**Origin:** Felipe insight 2026-05-20 — "Microsite puede ser GitHub skill, primer mensaje es lo que define el producto"

**Insight:**
Microsite, gifting, sequences — todo amplifica. Pero si primer mensaje no convierte, nada importa. Spleed core value = quality del primer mensaje (opening message).

**Sprint 7 Composer focus:**
- Multiple opening variants generated per lead
- Hook classification (mutual connection, recent news, specific pain, event-based, podcast quote, expansion signal, hiring signal, etc)
- Founder picks best variant from 2-3 options
- A/B testing infrastructure foundation (feeds Hermes Sprint 8)

**Quality metrics tracked (Sprint 8 Hermes captures):**
- Open rate per opening variant
- Reply rate per opening variant
- Meeting-booked rate per opening variant
- Time-to-meeting (some opens take long, that's OK signal)

**Anti-patterns to avoid:**
- Generic Apollo-style template feel
- Sales-y AI-generated obvious
- Spam mimicry triggers
- Over-formal corporate speak

**Microsites status (deferred from "core" to "feature"):**
- Microsites SÍ generan Sprint 7 (Composer puede generarlos)
- PERO no son pitch principal del producto
- Tier básico: outreach + tracking (sin microsite)
- Tier premium: + microsites + gifting

---

### BACKLOG-032: Hermes Sprint 8 lightweight implementation

**Status:** Sprint 8 implementation committed
**Priority:** ⭐⭐ CRITICAL — sets up data flywheel from day 1
**Origin:** Decision 2026-05-20 — lightweight Sprint 8, full Sprint 12+

**Sprint 8 scope — Feedback capture infrastructure only:**

- agent_feedback table (already in schema Sprint 1-2, extend if needed):
  - lead_id, draft_id, agent_type, action_taken (approved/edited/rejected), original_output, edited_output, founder_id, timestamp, outcome_known

- Webhook handlers para outcomes:
  - Email replied → feedback row updated
  - Meeting booked → success outcome
  - 30 days silence → fail outcome
  - Lead unsubscribe → strong negative signal

- Slack approval flow → feedback row creation:
  - Founder presses "Approve" → action_taken = approved
  - Founder presses "Edit" → action_taken = edited, capture diff
  - Founder presses "Reject" → action_taken = rejected
  - Founder skips → action_taken = ignored (after timeout)

- Dashboard visibility (Sprint 9-10):
  - Founder sees count of feedback collected
  - "Tu Spleed ha aprendido de X drafts esta semana"
  - Visual de patterns (high-level, sin exposing prompt internals)

**NOT in Sprint 8 (deferred Sprint 12+):**
- Pattern extraction job
- Master prompt evolution
- A/B testing infrastructure
- Per-tenant prompt versioning

**Why lightweight Sprint 8:**
- Sin volume de feedback real (necesitás 60-90 días de uso), pattern extraction no tiene material para trabajar
- Sprint 11 MVP timeline mantiene vs slip a Sprint 13
- Data captured desde día 1 → cuando Sprint 12 implementemos full version, hay material real

**Success criteria Sprint 8:**
- Sebastián concierge work genera 500+ feedback rows en mes 1
- Outcomes tracking 80%+ leads (sent → outcome known)
- Slack approval UI low-friction (founder no abandona)

**Dependencies:**
- Composer (Sprint 7) generates drafts (input)
- Outreach Operator (Sprint 7-8) captures outcomes (input)
- Dashboard (Sprint 9-10) shows learning (output)

**Sprint 12+ full version preview:**
- Pattern extraction job (BullMQ weekly per tenant)
- Master prompt updates per tenant in agent_templates
- A/B testing prompt_variants table (NEW)
- Tenant runs variants, winner becomes active

---

## Cómo se mantiene este archivo

- Cuando una decisión de producto se difiere conscientemente, se agrega aquí
- Cada item tiene ID único (BACKLOG-NNN) para referencia en commits
- Cuando se implementa un item, se marca `[DONE]` y se mueve a `/docs/done.md`
- Antes de cada sprint, leer items aplicables a ese sprint
- Si un item se vuelve irrelevante, se marca `[CANCELLED]` con razón

---

**Última actualización:** Sprint 1 cierre — 2026-05-11
**Versión:** 0.4
**Owner:** Felipe
