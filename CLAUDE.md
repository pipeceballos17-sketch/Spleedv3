# Spleed — Master Prompt for Claude Code (Antigravity IDE)

> Pega este archivo como `CLAUDE.md` en el root del repositorio. Claude Code lo carga automáticamente como contexto persistente en cada sesión. Si algo cambia (nueva integración, decisión arquitectónica), edita este archivo en lugar de improvisarlo en chat.

---

## 0. Identidad del proyecto

**Producto:** Spleed
**Categoría:** Agentic SaaS — GTM agent para founder-led sales
**Tagline interno:** "Your AI growth co-founder. Enriches leads cross-channel, books meetings, sends gifts, all with you in the loop."
**ICP:** Early-stage founders (pre-seed con tracción, seed early) US-based, generando $10K+ MRR, sin budget para SDR, haciendo founder-led sales
**Estado:** Greenfield. No hay código previo. Se construye desde cero con Claude Code.
**Owner:** Solo founder técnico (Felipe). Nivel de seniority de ingeniería: intermedio. Prefiere explicaciones tied al problema, sin analogías genéricas. Output limpio y copy-paste ready.

**Reglas de comunicación con Claude Code:**
- Antes de generar código complejo, explica brevemente la decisión arquitectónica en 2-4 líneas
- Cuando haya 2+ opciones técnicas válidas, presenta ambas con trade-offs antes de elegir
- Nunca asumas conocimiento de patterns avanzados (event sourcing, CQRS, etc.) sin explicarlos primero
- Output de código siempre con comentarios en secciones críticas, no en cada línea
- Si una decisión depende de info que no tienes, pregunta antes de inventar

---

## 1. Pitch funcional (qué hace Spleed)

Spleed es un workspace agéntico donde un founder define su ICP en lenguaje natural y 5 agentes especializados ejecutan el ciclo completo de outbound founder-led:

1. **Scout** — Descubre decision makers ultra-calificados según el ICP cross-channel
2. **Profiler** — Enriquece cada lead con threat search profundo en LinkedIn, X, GitHub, Reddit, HN, Substack, podcasts. Detecta pains, intereses, gift signals
3. **Composer** — Genera asset hyper-personalizado por lead (microsite en `lead.spleed.ai/[slug]`, demo, audit, ROI calculator)
4. **Outreach Operator** — Manda asset por canal preferido del lead, secuencia follow-ups multicanal, espera booking
5. **Gifter** — Cuando detecta gift signal + engagement, propone gift personal, lo compra con Stripe Issuing virtual card (con approval del founder vía iMessage), envía a oficina del lead

Todo en un kanban tipo Houston (cada card = un lead = una conversación persistente entre humano y agentes). Founder ve cada acción, aprueba, edita, comenta. Los agentes nunca actúan opacamente.

**El moat diferencial:**
- Cross-channel real desde día 1 (no email-only como 11x/AiSDR)
- Microsites personalizados como asset central (nadie en AI SDR space hace esto bien)
- Gifting integrado al pipeline (no producto separado tipo Sendoso)
- Founder-led ICP claro (UX para 1 founder, no team de SDRs)
- Human-in-the-loop vía iMessage (no Slack genérico)

---

## 2. Stack confirmado y restricciones

### Hosting & runtime
- **Vercel** ($20/mes Pro) — Frontend Next.js + microsites públicos con dominio comodín
- **Railway** ($25/mes) — Backend workers, queues, agent runtime. Postgres si se necesita además de Supabase
- **Supabase Free tier** — Auth, Postgres, RLS, Vault, Storage. Upgrade a Pro ($25) cuando MAU > 50K
- **Apify** ($80 cargados) — Scraping cross-channel (LinkedIn posts, X, Reddit, etc.). Reemplaza la idea original de Browserbase para MVP
- **Claude Teams** ($100/mes) — API access vía workspace Anthropic

### Agentes & LLM
- Modelo principal: `claude-sonnet-4-6` para Profiler y Composer (calidad crítica)
- Modelo liviano: `claude-haiku-4-5` para Scout, deduplicación, clasificación
- **Prompt caching obligatorio** desde día 1 en system prompts de cada agente (system prompts son largos = ahorro enorme)
- Batch API para tareas asíncronas masivas (Profiler nocturno de 200 leads)

### Integraciones externas
- **Apify** — Reemplaza Browserbase. Actores: LinkedIn Profile Scraper, LinkedIn Posts, X Tweet Scraper, Google Search, GitHub. Costo por uso, ya cargado.
- **Apollo** — BYO (cada tenant trae su API key). NO pagamos cuenta master en MVP
- **Resend** — Email transactional (microsites, notifs internas) y outbound (founders mandan desde sus dominios via OAuth Gmail)
- **Sendblue** — iMessage API para HITL approvals ($100/mes/línea, agregar cuando primer pago llegue)
- **Stripe** — Billing del SaaS + Stripe Issuing para gift cards virtuales (aplicar como platform en sprint 0)
- **Google Calendar API** — Booking sync, event creation
- **Cal.com** — Embeber scheduling links en microsites (open source, usa el self-hosted o cloud free)

### Frontend
- **Next.js 15 App Router** + TypeScript estricto + Tailwind v4
- **shadcn/ui** como componente library base
- **Design system:** seguir spec `DESIGN.md` (formato Google Labs) en `/design/DESIGN.md` — limpio, agéntico, similar a Houston.ai (mucho whitespace, mono fonts para tech, neutrales cálidos)
- **Figma** ($12/mes) — diseño de pantallas críticas antes de implementar
- **Lucide icons** — único set de iconos
- **Framer Motion** solo donde aporta función, no decoración

### Dev environment
- **Antigravity IDE** (Google Labs) con Claude Code agent
- **Bun** como package manager y runtime (más rápido que npm, compatible)
- **Turbo** monorepo (apps/web, apps/api, packages/shared, packages/agents, packages/db)
- **Drizzle ORM** sobre Supabase Postgres (más type-safe que Prisma para nuestro caso)
- **Zod** para validación end-to-end
- **tRPC** entre Next.js y backend Railway

### Lo que NO usamos (decisiones tomadas)
- ❌ Browserbase — caro para MVP, Apify nos alcanza
- ❌ WhatsApp — canal inestable, evitar explícitamente
- ❌ Slack para approvals — usamos iMessage como diferenciador
- ❌ Prisma — Drizzle es mejor para edge runtime
- ❌ Redux/Zustand global — TanStack Query maneja server state
- ❌ Microservicios — monolito modular en Railway hasta 100+ tenants

---

## 3. Filosofía de arquitectura

### El patrón Houston (heredado, no copiado literal)
- Cada agente se define declarativamente en archivos `houston.json` (metadata) + `CLAUDE.md` (system prompt). En Spleed: `agent.json` + `prompt.md`
- Cada lead = una card = una conversación persistente. Humano y agente comparten CRUD sobre los mismos datos
- Los agentes son tools del workspace, no dueños. Founder puede editar manualmente cualquier output
- Workspaces agrupan agentes (futuro: founder podría tener workspace "outbound a CTOs" y otro "outbound a CFOs")

### Multi-tenancy desde el día 1
Tomamos la lección del artículo de FASTN/Golden Builds: **multi-tenancy no es solo systems-level, es contexto + memoria + sesión scoped**. Implementamos con tres capas:

1. **Identidad y aislamiento de datos:** `org_id` en TODA tabla operacional. RLS Supabase forzando que ningún query pueda omitir el filter. Test suite que prueba aislamiento en CI.
2. **Memoria scoped por agente y por lead:** cada agente tiene su own context window por (org_id, agent_id, lead_id). Nunca se cruza memoria entre tenants.
3. **Configuración per-tenant:** cada org tiene su propio system prompt template para cada agente (heredan default, pueden override). API keys de Apollo, Gmail OAuth, etc., per-org en Supabase Vault.

### Backend-first, frontend-second
**Construimos en este orden estricto:**
1. Schema DB + RLS policies + migration system
2. Auth + tenant provisioning
3. Agent runtime (cómo se ejecuta un agente, cómo persiste estado)
4. Tools/integrations layer (Apify, Apollo wrapper, Resend, Stripe)
5. Queue + workers (BullMQ sobre Redis Upstash)
6. Los 5 agentes (Scout → Profiler → Composer → Outreach → Gifter), uno a la vez
7. iMessage HITL flow
8. tRPC API
9. Frontend dashboard
10. Microsites públicos

No empezamos UI hasta que el backend esté funcional end-to-end con curl/scripts. Esto previene el anti-pattern de "dashboard bonito sin lógica detrás".

### Human-in-the-loop como first-class citizen
Cada acción que un agente toma puede ser:
- **AUTO** — Ejecutada sin pedir aprobación (ej: enriquecer lead, generar dossier)
- **NOTIFY** — Ejecutada y notificada al founder (ej: enviar email outbound)
- **APPROVE** — Bloqueada hasta que founder apruebe (ej: comprar gift > $X, enviar mensaje muy personalizado)

El nivel default por acción está en config, pero el founder puede ajustar globalmente o por agente. APPROVE actions van vía iMessage (Sendblue) con screenshots/info recolectada y un botón virtual ("YES" / "NO" / "EDIT: [nuevo texto]"). Failover a email si iMessage falla.

---

## 4. Schema de DB (orden de implementación)

Usar Drizzle. Migrations en `/packages/db/migrations`. Cada tabla tiene `id` (uuid), `org_id` (uuid, FK), `created_at`, `updated_at`. RLS habilitada por default en TODAS.

### Sprint 1 (semana 1) — Fundación
```sql
-- Identidad
orgs (id, name, slug, plan, gift_budget_cap, gift_approval_threshold)
users (id, email, name, supabase_auth_id)
org_members (org_id, user_id, role: owner|member)

-- Connectors per-tenant
org_integrations (org_id, kind: apollo|gmail|imessage|stripe_issuing, encrypted_credentials, status, connected_at)
```

### Sprint 2 (semana 2) — Agentes y workspace
```sql
-- Agent definitions (defaults + overrides por org)
agent_templates (id, kind: scout|profiler|composer|outreach|gifter, default_prompt, default_config)
org_agents (org_id, template_id, custom_prompt, custom_config, enabled)

-- ICP / target market definition
icps (id, org_id, name, definition_natural_language, parsed_filters_jsonb)
```

### Sprint 3 (semana 3) — Pipeline core
```sql
-- The kanban
leads (id, org_id, icp_id, status: discovered|enriched|composed|engaged|tracking|gift_pending|booked|lost,
       full_name, first_name, last_name, company, role, email, linkedin_url, x_handle, github_handle,
       found_via, fit_score)

-- Cross-channel dossier (output de Profiler)
lead_dossiers (lead_id, org_id, pains_jsonb, interests_jsonb, gift_signals_jsonb,
               recent_changes_jsonb, preferred_channel, raw_signals_jsonb, confidence_score)

-- Conversación persistente humano <-> agentes por lead
lead_threads (id, lead_id, org_id, agent_kind, role: agent|user|tool, content, metadata_jsonb)
```

### Sprint 4 (semana 4) — Outreach + tracking
```sql
-- Generated assets (microsites, demos)
assets (id, lead_id, org_id, kind: microsite|demo_video|audit_pdf|roi_calculator|loom_script,
        slug, content_jsonb, public_url, og_image_url, view_count, unique_viewer_count,
        last_viewed_at, preferred_outreach_message, published_at, deleted_at)

-- Outreach messages sent (state-on-row mutable; service-role-only INSERT/UPDATE)
outreach_events (id, lead_id, org_id, asset_id, channel: email|linkedin|x|imessage,
                 direction: outbound|inbound, subject, content, provider_message_id,
                 status, sent_at, delivered_at, opened_at, replied_at, bounced_at,
                 sequence_position)

-- Microsite tracking pixel events (NO raw IP — hashed fingerprint only)
tracking_events (id, asset_id, lead_id, org_id, kind: page_view|cta_click|video_play|calendar_open|calendar_book,
                 session_fingerprint, referrer, metadata_jsonb)
```

**Sprint 4 invariants (must hold for any code writing to these tables):**

1. **Atomic counter sync (tracking_events ↔ assets):** The ingest worker (Sprint 7)
   MUST wrap `INSERT tracking_events` + `UPDATE assets` (view_count, unique_viewer_count,
   last_viewed_at) in a single SQL transaction. Never two separate writes — desync
   risk on partial failure.

2. **No raw IP in tracking_events:** The ingest endpoint (Sprint 7) MUST hash
   `sha256(asset.id || ':' || ip || ':' || user_agent)` into `session_fingerprint`
   BEFORE insert. Raw IP must never appear in this table — not as a column, not
   inside metadata jsonb. App-layer enforcement (no DB trigger).

3. **Slug is permanently reserved:** `assets.slug` is globally unique and NEVER
   reused — even after soft-delete. The `assets_slug_unique` index is NOT partial.
   Composer (Sprint 7) appends a random suffix to prevent practical collisions
   across leads/orgs.

4. **outreach_events threading (deferred to Sprint 7):** Inbound/outbound thread
   correlation is not modeled in Sprint 4. Options on the table: `parent_event_id`
   self-reference, `provider_thread_id` from Resend/LinkedIn, or app-layer join
   via `lead_id` + temporal order. Decision lands when we build the inbound reply
   ingest in Sprint 7.

### Sprint 5 (semana 5) — Gifting + approvals
```sql
-- Gift proposals + execution
gifts (id, lead_id, org_id, status: proposed|approved|rejected|purchased|shipped|delivered,
       product_name, merchant, cost_cents, virtual_card_id, shipping_address_jsonb,
       reasoning, message_to_lead)

-- HITL approval requests (genérico para gifts y otras acciones)
approval_requests (id, org_id, kind: gift|outreach|other, payload_jsonb,
                   status: pending|approved|rejected|expired,
                   sent_via: imessage|email, decided_at, decided_by_user_id)
```

### RLS policies pattern (aplicar a TODAS las tablas con `org_id`)

```sql
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenants_isolated" ON leads
  USING (org_id = (auth.jwt() ->> 'org_id')::uuid);

CREATE POLICY "tenants_insert" ON leads
  FOR INSERT WITH CHECK (org_id = (auth.jwt() ->> 'org_id')::uuid);
```

**Test obligatorio en CI:** crear 2 orgs, insertar leads en cada una, verificar que queries con JWT de org_A nunca devuelvan leads de org_B. Si este test falla, el deploy se bloquea.

---

## 5. Agent runtime (cómo se ejecuta un agente)

### Estructura de un agente
```
/packages/agents/scout/
  agent.json          # metadata: name, kind, version, tools
  prompt.md           # system prompt template (con variables {{org.name}}, {{icp.definition}})
  tools/              # tools que solo este agente usa
    apollo_search.ts
    apify_linkedin_search.ts
  index.ts            # export default function runScout(input, ctx)
```

### Run loop pattern
Todo agente sigue este ciclo:

```ts
async function runAgent(agentKind, leadId, orgId, trigger) {
  const ctx = await buildAgentContext(agentKind, leadId, orgId);
  // ctx incluye: system prompt resolved, tools available, conversation history,
  // org config, lead data, RLS-scoped DB client

  const stream = await anthropic.messages.stream({
    model: ctx.model,
    system: [
      { type: "text", text: ctx.systemPrompt, cache_control: { type: "ephemeral" } }
    ],
    messages: ctx.messages,
    tools: ctx.tools,
    max_tokens: ctx.maxTokens,
  });

  for await (const event of stream) {
    if (event.type === "tool_use") {
      const result = await executeTool(event, ctx);
      ctx.messages.push({ role: "tool", content: result });
    }
    // persist every event to lead_threads
    await persistEvent(event, leadId, orgId, agentKind);
  }
}
```

### Tools layer
Tools son funciones puras `(input, ctx) => output` que:
- Reciben `ctx.orgId` y SIEMPRE filtran por él
- Usan credenciales del Vault de Supabase para ese org
- Retornan resultados estructurados (Zod-validated)
- Loggean cada llamada en `tool_call_logs` (para debug y rate limiting)

Ejemplo de tool registration:
```ts
export const apolloSearchTool = defineTool({
  name: "apollo_search",
  description: "Search Apollo.io for decision makers matching ICP criteria",
  input: z.object({
    titles: z.array(z.string()),
    industries: z.array(z.string()),
    company_size_min: z.number().optional(),
    company_size_max: z.number().optional(),
  }),
  execute: async (input, ctx) => {
    const apiKey = await getOrgCredential(ctx.orgId, "apollo");
    if (!apiKey) throw new ToolError("APOLLO_NOT_CONNECTED", "User needs to connect Apollo first");
    return await apolloClient(apiKey).search(input);
  },
});
```

### Queue + workers
- **BullMQ** sobre Redis Upstash (free tier para MVP, ~100K commands/día)
- Cola por agente: `scout`, `profiler`, `composer`, `outreach`, `gifter`
- Cola separada `human_followup` para retries de approval expirados
- Workers en Railway (process separado, scale horizontal cuando necesario)
- Cada job tiene `org_id` en metadata, workers usan ese contexto para todo

### Cron / routines
Heredamos el concept de Houston routines:
- `org_routines` table: cron expression + agent kind + payload template
- Worker dedicado lee tabla cada minuto, encola jobs según schedule
- Default routines por org al onboarding: "Scout 50 new leads daily at 9am org timezone", "Re-enrich engaged leads weekly"

---

## 6. iMessage HITL flow (Sendblue)

### Setup
- Sendblue cuenta master, una `phone_line` por org (compartida en MVP, dedicada en Tier Team+)
- Founder al onboarding: agrega su número personal, verifica con código (Sendblue handles this)
- Linkea `org_member.imessage_phone` con su número

### Flow de approval
1. Agent genera acción que requiere approve (ej: gift de $73)
2. Backend crea row en `approval_requests` con `status=pending` + payload completo
3. Backend formatea mensaje iMessage con:
   - Resumen breve del lead (nombre, empresa, por qué este gift)
   - Detalles de la compra (producto, costo, merchant, dirección de envío)
   - Screenshot del producto (Apify scraped + uploaded a Supabase Storage)
   - Link corto al dashboard para detalles + edit
   - Instrucción: "Reply YES to approve, NO to reject, or EDIT: <new text> to modify"
4. Sendblue API envía iMessage al founder
5. Sendblue webhook recibe respuesta del founder
6. Backend parsea respuesta:
   - "YES" / "Y" / "👍" / "✅" → status=approved → trigger ejecución
   - "NO" / "N" / "👎" / "❌" → status=rejected → notificar agente, agente decide alternativa
   - "EDIT: ..." → status=pending, agente regenera con feedback
   - Otra cosa → fallback a clarification: "I didn't get that. Reply YES, NO, or EDIT:"
7. Si no hay respuesta en 4 horas, fallback a email con misma info
8. Si no hay respuesta en 24 horas, status=expired, agente skip-ea o reintenta

### Failover gracioso
Apple puede romper APIs privadas en cualquier release de iOS. Diseñar SIEMPRE con fallback:
1. Intentar iMessage vía Sendblue
2. Si Sendblue retorna error o no entrega en 5 min → email con misma estructura
3. Tracker `delivery_method_used` para alertar si Sendblue tiene tasa alta de fallo

---

## 7. Frontend (después del backend)

### Estructura
```
/apps/web/
  app/                    # Next.js App Router
    (auth)/login          # Supabase Auth
    (app)/                # autenticado
      dashboard           # overview metrics
      leads               # kanban view (drag entre columnas)
      leads/[id]          # detail view: dossier, threads, assets, outreach history
      icp                 # ICP definition + edit
      agents              # editar prompts y configs por agente
      integrations        # connectors (Apollo, Gmail, iMessage)
      gifts               # gift history + budget
      settings            # billing, team, notifications
    [slug]                # MICROSITES PÚBLICOS (no autenticados)
                          # served en lead.spleed.ai/[slug] vía middleware rewrite
```

### Design system
**Cargar `/design/DESIGN.md` en cada sesión de Claude Code.** Es el spec del visual identity (formato Google Labs `design.md`).

Tokens base (preliminares, validar con Figma antes de codear):
```yaml
name: Spleed
colors:
  primary: "#0A0A0A"        # Near-black, sharp text
  secondary: "#71717A"      # Slate, borders metadata
  tertiary: "#FF6B35"       # Spleed orange, CTAs (único accent)
  neutral: "#FAFAF9"        # Warm off-white, background
  surface: "#FFFFFF"        # Cards
  success: "#16A34A"
  danger: "#DC2626"
typography:
  display: { fontFamily: "Geist", fontSize: "3rem", fontWeight: 600 }
  h1: { fontFamily: "Geist", fontSize: "2rem", fontWeight: 600 }
  body: { fontFamily: "Geist", fontSize: "1rem" }
  mono: { fontFamily: "Geist Mono", fontSize: "0.875rem" }
rounded:
  sm: 6px
  md: 10px
  lg: 14px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
```

**Principios visuales (estilo Houston.ai):**
- Mucho whitespace, jerarquía clara
- Mono fonts para datos técnicos (IDs, timestamps, tokens)
- Sans serif limpio para texto general
- Single accent color (Spleed orange) — nunca usar 2+ accents en pantalla
- Borders sutiles (1px, neutral-200), sombras casi inexistentes
- Iconografía Lucide consistente, nunca emojis en UI productiva
- Estados de agentes con micro-animaciones sutiles (typing dots cuando está pensando)

### Pantallas críticas (orden de implementación)
1. **Login + onboarding wizard** (5 pasos: org name, ICP, conectar Apollo, conectar Gmail, definir gift budget)
2. **Leads kanban** — la pantalla más usada. Columnas = status. Drag&drop. Cada card muestra avatar, nombre, empresa, último signal, agentes actuales corriendo
3. **Lead detail** — split view: izquierda dossier, derecha thread de conversación humano-agente con timeline. Tabs: Dossier, Outreach, Assets, Gifts, Activity
4. **Approval inbox** — lista de approval_requests pendientes (también van por iMessage pero el founder puede preferir batch desde web)
5. **Integrations** — un card por connector con estado, último sync, botón de reconectar
6. **Gift dashboard** — qué gifts se mandaron, ROI (meetings booked tras gift), budget usage
7. **ICP editor** — text area con LLM-assisted refinement
8. **Microsite template** — la pantalla pública que ven los leads. Sobria, personal, no AI-vibe

### Patterns de UI
- Server components por default, client components solo donde hay interactividad
- TanStack Query para todo server state
- Optimistic updates en kanban drag
- Streaming UI para outputs de agentes (mostrar tokens mientras llegan, no esperar completion)
- Toast notifications: solo confirmaciones, errores siempre con CTA de retry o ayuda

---

## 8. Plan de sprints (12 semanas, alineado con roadmap previo)

### Sprint 0 (esta semana) — Setup
- [ ] Crear repo monorepo Bun + Turbo
- [ ] Setup Antigravity con este `CLAUDE.md` cargado
- [ ] Inicializar Supabase project, run primera migration
- [ ] Conectar Vercel + Railway, primeros deploys vacíos pero verdes
- [ ] Aplicar a Stripe Issuing como platform (toma 2-6 sem)
- [ ] Comprar 5 dominios secundarios para email warmup

### Sprint 1-4 — Backend foundation (multi-tenancy real)
Ver sección 4 para schema. Outputs:
- Auth working con Supabase
- RLS suite de tests pasando en CI
- Vault de credenciales con encryption-at-rest
- Agent runtime ejecutando un "hello world" agent en queue
- Apify integration funcionando con un solo actor (LinkedIn Profile)

### Sprint 5-8 — Los 5 agentes
- Sprint 5: Scout end-to-end (input ICP → output 50 leads en columna Discovered)
- Sprint 6: Profiler end-to-end (output dossier rico de cada lead) con agent-browser de Vercel para top 30% leads por fit_score (browser-strategic enrichment). **Critical week** — calidad del Profiler determina todo lo siguiente
- Sprint 7: Composer + Outreach Operator (microsite + email/LI sent)
- Sprint 8: Gifter + iMessage approval flow + Stripe Issuing

### Sprint 9-12 — Frontend, design partners, billing
- Sprint 9: Frontend dashboard funcional (kanban + lead detail + integrations)
- Sprint 10: Onboarding 5 design partners, fixes según feedback
- Sprint 11: Stripe billing real, primeros pagos
- Sprint 12: Hardening, security review, runbooks

> **DECISION 2026-05-11 (cierre Sprint 2):** Browser strategy adelantado de Phase 2 a Sprint 6. Justificación: agent-browser de Vercel (32.7K stars GitHub, producción) encapsula la complejidad de Phase 2 con setup mínimo. Beneficio: producto realmente diferenciado desde MVP (autonomía dirigida con cobertura real, anti-hallucination via screenshots, behavioral signals). Costo: ~$15/founder/mes adicional COGS (browser cloud sessions). Margin Founder tier: 68% → 66%.

---

## 9. Reglas operacionales para Claude Code

Estas son las que te rigen como agente de desarrollo en Antigravity. Síguelas estrictamente.

1. **Cada sprint empieza con un plan corto.** Antes de codear, lista las tareas, sus dependencias, y qué va al final del sprint a `git commit -m "..."`. Confirmar con Felipe antes de proceder.

2. **Nunca codees frontend sin backend funcional.** Si no podés probar el endpoint con curl, no construyas la UI que lo consume.

3. **Cada feature nueva agrega un test.** No 100% coverage, pero sí: happy path + el caso de aislamiento multi-tenant cuando aplique.

4. **Migrations son sagradas.** Una vez aplicada en producción (después de design partners), nunca editar. Crear nueva migration que reverse o corrija.

5. **Secrets en `.env.local` y Supabase Vault.** Nunca commitear API keys. Pre-commit hook con `gitleaks`.

6. **Antes de instalar una dependencia, justificá.** Cada `bun add` suma surface area. Preferir built-ins y código propio cuando sea < 50 líneas.

7. **Logs estructurados desde día 1.** Pino con JSON output. Nunca `console.log` en código de producción. Cada log con `org_id`, `agent`, `lead_id` cuando aplique.

8. **Errores tipados con Zod.** Nunca `throw new Error("something")`. Siempre `throw new TaggedError("APOLLO_NOT_CONNECTED", { context })`.

9. **Cuando dudes entre 2 enfoques, escoger el que es más fácil de borrar.** Pre-seed = optimizar para velocidad de iteración, no por elegancia.

10. **Documentar decisiones no-obvias en `/docs/adr/`** (Architecture Decision Records). Una página por decisión: contexto, opciones consideradas, decisión, consecuencias.

---

## 10. Lo que NO está en el MVP (decir NO es trabajo)

No construir nada de esto antes del sprint 13:
- Mobile app nativa (iMessage cubre el use case mobile-critical)
- Integraciones CRM (Salesforce, HubSpot)
- Multi-language (English-first, Felipe trabaja en US market)
- Marketplace de prompts compartidos
- A/B testing de copy con stats significancia (manual A/B en sprint 11 está bien)
- Self-serve signup público (cohorts cerrados hasta semana 16+)
- White-label
- RBAC complejo (owner+member es suficiente)
- Voice agent / phone outreach
- Browser extension (Phase 2, después de PMF)
- Analytics dashboard avanzado (5 métricas claras > 50 borrosas)

Si Felipe pide algo de esta lista durante MVP, recordarle este archivo y preguntar si vale la pena retrasar el roadmap.

---

## 11. Checklist de "done" para semana 12

El producto está "done" para Series A pitch cuando:
- [ ] 5 design partners pagando ≥1 mes
- [ ] Tasa de reply > 8% (vs 1-3% benchmark cold email)
- [ ] Tasa de meeting booked > 1% sobre leads totales
- [ ] Gift approval rate > 70% (founders aprueban ≥7 de 10 propuestas)
- [ ] Tiempo founder-en-app < 30 min/día
- [ ] RLS test suite verde, cero leaks cross-tenant
- [ ] Cero compras Stripe Issuing no autorizadas
- [ ] Onboarding < 10 min sin ayuda humana
- [ ] iMessage delivery rate > 95% (con failover email para el resto)

Si 3+ de estos están en rojo en semana 12, NO levantar ronda — iterar 4 semanas más antes.

---

## 12. Repositorios de referencia (heredar patterns, no copiar literalmente)

- **Houston** (`gethouston/houston`) — arquitectura de agentes declarativos, kanban, workspaces
- **agent-browser** (`vercel-labs/agent-browser`) — patterns de browser automation con auth vault (para Phase 2 cuando reemplacemos parte de Apify)
- **browser-use** (`browser-use/browser-use`) — patterns de agent loop nativo (referencia, no usamos)
- **design.md** (`google-labs-code/design.md`) — formato del visual identity spec
- ~~AgentGPT~~ — archivado, no usar como referencia

---

## 13. Cómo arrancar (primera sesión Claude Code)

Cuando Felipe abra Antigravity y diga "vamos", responder con:

1. Confirmar que entendiste el contexto leyendo este `CLAUDE.md` (resumen de 5 líneas)
2. Listar el setup del Sprint 0 con checkboxes
3. Preguntar: "¿Empezamos por inicializar el monorepo o ya lo hiciste?"
4. Si Felipe responde "empezar", generar comandos exactos paso a paso
5. NO generar código de agentes, schema, ni UI hasta que el monorepo + Supabase + Railway + Vercel estén verdes

---

**Fin del CLAUDE.md.**
**Versión:** 0.1
**Última actualización:** Sprint 0
**Owner:** Felipe (founder)
