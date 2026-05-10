# Spleed — End-to-End Flow Specification (v0.3)

> Documento de referencia para implementación. Define el flujo completo del lead a través del sistema: cómo entra, cómo viaja, qué decisiones se toman, cuándo el founder interactúa, qué outputs se producen.
> 
> Este es el documento que **Claude Code lee antes de implementar agentes**. Reemplaza implícitos por explícitos.
>
> Versión: 0.3 (consolida master prompt v0.1 + patch v0.2 + flow spec v0.3)

---

## Filosofía del flujo

Cinco principios que rigen TODO lo que sigue:

**1. Quality over quantity.** Mejor 30 leads enriquecidos al 90% de calidad que 200 al 40%. Los founders pre-seed no tienen tiempo para cribar lista grande de mediocres.

**2. Founder en el loop, no en la silla.** El founder NO opera la app. Concierge le texta lo importante. La app es respaldo visual cuando él quiere ver detalles.

**3. Screenshots como verdad ground.** Cuando un agente toma una decisión basada en data scrapeada (perfil de LinkedIn, post de X), captura screenshot y se lo manda al founder con la decisión. Antialucinación obligatoria.

**4. Cada acción tiene un priority level.** P0 = interrumpe siempre. P1 = notifica respetando quiet hours. P2 = digest diario. La discriminación es el moat — productos que notifican todo se vuelven ruido.

**5. Gifting NO es un add-on, es estratégico.** Va antes, durante, o después de la reunión según el contexto del lead. El timing es decisión consciente, no aleatoria.

---

## Las 7 fases del flujo

```
[1. Discovery]
    ↓
[2. Enrichment]   ←── 70% de impacto del producto está aquí
    ↓
[3. Composition]
    ↓
[4. Initial Outreach]
    ↓
[5. Engagement Tracking]
    ↓
[6. Booking]
    ↓
[7. Gifting]   ←── timing variable según signals
```

Pero NO es lineal. Hay branches reales:

```
                ┌─────────────────────────────────┐
                │                                 │
[Discovery] → [Enrichment] → [Composition] → [Outreach] → [Tracking]
                ↓ (signal: birthday/promotion)         ↓ (no engagement)
            [Pre-meeting gift]                    [Breakup msg]
                ↓                                      ↓
            [Soft outreach]                          [Lost]
                ↓ (replies positively)
            [Booking] → [Post-meeting gift] → [Follow-up nurture]
                ↓ (no reply pero engagement)
            [Mid-funnel gift]
                ↓
            [Re-outreach]
```

A continuación, cada fase con:
- Quién la ejecuta
- Inputs/outputs
- Decision points
- Founder interactions
- Outputs por tipo de tenant

---

## Fase 1 — Discovery

**Agente:** Scout (Haiku 4.5, rápido y barato)

**Trigger:**
- Founder define ICP en onboarding (primera vez)
- Cron diario a las 6 AM org timezone (Concierge schedule)
- Manual: founder texta "find more leads like Sarah at Acme"

**Inputs:**
- ICP definition (lenguaje natural + filtros parsed)
- Quota: leads to find this run (default 50, configurable)
- Excluded list: companies/people to skip (founder-managed)

**Proceso interno (hidden de founder):**

1. **Apollo search** (highest signal) — 30-50 leads typically
2. **Funding signals** vía Apify Crunchbase actor — empresas que cuadran ICP + raised <90 días
3. **Hiring signals** vía Apify Google search — empresas hiring para roles que indican pain
4. **GitHub** (si ICP es technical) — owners/contributors de repos relevantes
5. **Long tail** (si 1-4 no llenaron quota) — Google generic con queries diversas

Cada lead pasa por:
- **Dedupe check** — ya está en pipeline? skip
- **Excluded list check** — founder marcó esta empresa? skip
- **Fit score calculation** — 0-1 basado en match con filtros
- **Threshold filter** — fit_score < 0.5 → reject silently

**Outputs:**

```json
{
  "run_id": "uuid",
  "leads_found": 47,
  "leads_added_to_pipeline": 31,  // after dedupe + threshold
  "leads_rejected": 16,
  "breakdown": {
    "apollo": 18,
    "crunchbase_funding": 7,
    "hiring_signal": 4,
    "github": 2
  },
  "icp_quality_flags": [
    "Industry filter 'fintech' returned 60% of results — consider narrowing",
    "Geography filter 'LATAM' returned only 3 results — too narrow?"
  ],
  "top_3_by_fit": [...]
}
```

**Founder interaction:**

Concierge envía P2 message en daily digest (no interrumpe):

```
Spleed digest – Tue Jan 15:

• Found 31 new leads (target was 50 — Apollo plan may be limiting)
• Top 3 fits:
  1. Sarah Chen, CFO at Acme — 94% fit (just raised Series B)
  2. Mike Park, Head of GTM at Beta — 91% fit
  3. Tina Liu, COO at Gamma — 88% fit
• 4 leads from hiring signals — Acme/Beta/etc are all hiring SDRs

Reply 1, 2, or 3 to fast-track that lead, or 'show all' for the full list.
```

**Variabilidad por tenant:**

| Tenant tipo | Discovery output característico |
|---|---|
| Pre-seed B2B SaaS targeting tech CTOs | Heavy GitHub + Apollo, 40-60 leads/run |
| Seed B2C marketplace targeting consumer founders | Apollo dominant, Crunchbase secondary, 20-30 leads (smaller TAM) |
| Pre-seed devtools targeting developers | GitHub primary, X secondary, Apollo bajo (devs no en Apollo) |
| Series A SaaS sales targeting CFOs | Apollo + Crunchbase funding signals dominant |

---

## Fase 2 — Enrichment (la fase más importante)

**Agente:** Profiler (Sonnet 4.6, calidad crítica)

**Trigger:** automático — cada lead nuevo en estado `discovered` se encola para Profiler.

**Inputs:**
- Lead básico (de Scout)
- Org context (qué vende el founder, value props, tono)

**Proceso por canales (Tier 1 → 3):**

### Tier 1 — Identity verification
- LinkedIn profile vía Apify
- Email enrichment si Scout no lo trajo

### Tier 2 — Active channels
- LinkedIn posts (last 20)
- X tweets (last 50)

### Tier 3 — Conditional (según signals)
- GitHub si technical
- Reddit si username inferable
- Hacker News si founder/technical
- Substack/newsletters
- Podcasts (Listen Notes API)

### **Aquí ocurre la magia: screenshot capture**

Cada vez que Profiler usa data crítica de un canal, **captura screenshot del source** vía Apify y lo guarda en Supabase Storage. Patrón:

```
Profiler reads: "Sarah's tweet from 3 days ago: 'Costa Rican coffee 
                obsession lately, anyone has roaster recommendations?'"

→ Apify takes screenshot of the actual tweet
→ Uploaded to /storage/orgs/{org_id}/dossier-evidence/{lead_id}/{signal_id}.png
→ Linked in dossier.gift_signals[0].screenshot_url
```

**Esto es clave para anti-alucinación.** Cuando Concierge le proponga al founder "let's send Sarah Costa Rican coffee", incluye el screenshot del tweet real, no solo "she likes coffee". El founder ve la evidencia y aprueba con confianza.

### Construcción del dossier

```json
{
  "lead_id": "uuid",
  "pains": [
    {
      "description": "Struggling with SDR onboarding ramp time",
      "source_url": "https://linkedin.com/posts/...",
      "source_quote": "We've gone through 3 SDRs in 6 months — onboarding is killing us",
      "screenshot_url": "https://supabase.../pain_1.png",
      "confidence": 0.92,
      "recency_days_ago": 12
    }
  ],
  "interests": [...],
  "gift_signals": [
    {
      "type": "specific_hobby_passion",
      "description": "Obsessed with single-origin Costa Rican coffee",
      "source_url": "https://x.com/sarah/status/...",
      "source_quote": "Costa Rican coffee obsession lately, anyone has roaster recs?",
      "screenshot_url": "https://supabase.../gift_1.png",
      "confidence": 0.88,
      "freshness_days": 3,
      "suggested_categories": ["specialty_coffee", "single_origin"]
    }
  ],
  "recent_changes": [
    {
      "kind": "funding",
      "description": "Series B announced ($45M from Sequoia)",
      "occurred_at": "2026-01-08",
      "screenshot_url": "..."
    }
  ],
  "preferred_channel": "x",
  "tone_match": {
    "formality": "casual",
    "humor": true,
    "length_preference": "short"
  },
  "confidence_score": 0.86
}
```

**Founder interaction:**

Profiler NO interrumpe al founder por enrichment normal. Solo notifica si:
- **High-fit lead detected** (score ≥ 0.85) → P1 notification
- **Insufficient signal** (confidence < 0.4) → P2 — "lead xyz is too thin to enrich, recommend deprioritize"
- **Mistaken identity risk** (common name + low cross-channel match) → P1 — "is this the right Tom Cook? confidence is low"

P1 message ejemplo:

```
🔥 High-fit lead enriched:

Sarah Chen, CFO at Acme — fit 94%

Top signals:
• Just announced Series B ($45M) – fundraising momentum
• Tweeted about SDR onboarding pain 12 days ago
• Costa Rican coffee enthusiast (gift signal!)

Recommended angle: SDR ramp time is hot. They have budget.
Asset suggested: pricing audit (their public page is dated).

Want me to compose? Reply YES, NO, or 'wait'.
```

**Variabilidad por tenant:**

Calidad del dossier varía dramáticamente por:
- **Lead activity:** Founder publicly active → dossier riquísimo. Stealth mode → dossier pobre, agente reporta esto honestamente.
- **ICP technical-ness:** Devtool ICPs tienen GitHub gold mine. SaaS general tiene LinkedIn-heavy.
- **Apify cuota:** Si tenant ya gastó mucho Apify este mes, Profiler usa solo Tier 1+2.

---

## Fase 3 — Composition

**Agente:** Composer (Sonnet 4.6)

**Trigger:** automático cuando dossier confidence ≥ 0.7. Si menor, encola en review humano.

**Decisión #1 — Tipo de asset**

Basado en dossier, Composer elige UNO:

| Asset type | Cuándo |
|---|---|
| **Microsite personalizado** | Default. 70% de leads. Pain claro + tone match disponible. |
| **Audit/diagnóstico** | Cuando hay observable issue en producto público del lead (pricing page, docs, landing). |
| **ROI calculator** | Cuando lead role es finance/ops AND hay datos públicos para pre-llenar. |
| **Loom script** | Cuando tone match indica preferencia por video AND founder bandwidth disponible. |
| **None / insufficient_signal** | Dossier demasiado thin. Skip lead, notificar founder. |

**Proceso del microsite:**

1. Generación de copy (hero + 3 secciones + CTA + sign-off)
2. Render preview vía templating
3. Slug único: `firstname-lastname-randomhash`
4. Publish a `lead.spleed.ai/{slug}`
5. OG image dinámica
6. Tracking pixel inyectado

**Founder interaction:**

Concierge envía P1 cuando microsite está listo:

```
Microsite ready for Sarah at Acme:
https://lead.spleed.ai/sarah-chen-x7k2

Hook: Series B + SDR ramp time pain.
Asset type: microsite (audit angle didn't work — their pricing page is solid)
Suggested first message:
"Hey Sarah — saw the Series B news 🎉. The SDR ramp problem you 
mentioned is exactly what we obsess over. Made you a quick page: 
[link]. 15 min if it lands?"

Channel: X DM (she's most active there)

Want me to send? YES / NO / EDIT message
```

Founder puede responder:
- `YES` → manda inmediato
- `NO` → archive, no manda
- `EDIT: less salesy, more curious` → Composer regenera copy con nuevo brief

**Variabilidad por tenant:**

| Tenant founder tone | Microsite character |
|---|---|
| `casual` | Tweets-style copy, emojis OK, contractions ("we're", "you're") |
| `formal` | Full sentences, no emojis, "we are", professional photography |
| `contrarian` | Provocative hook, challenges assumptions, blunt CTAs |
| `warm` | Empathy-first, acknowledges complexity, soft CTA |

Cada tenant tiene su microsite template visualmente distinto (color, font, copy structure).

---

## Fase 4 — Initial Outreach

**Agente:** Outreach Operator (Sonnet 4.6)

**Trigger:** Founder approves message, OR auto-send si org config = `auto`.

**Decisión de canal:**

1. `dossier.preferred_channel` (X, LinkedIn, email)
2. Si LinkedIn requires connection: send connection request first, wait 48h
3. Si X but lead has >5K followers: skip X, use email
4. Email default fallback

**Approval gating:**

Tres niveles configurables por org:
- `auto` — manda sin pedir
- `notify` — manda + notifica al founder con copy del mensaje
- `approve` — espera approval del founder antes de mandar

Por defecto: **`approve` para los primeros 30 días del founder en Spleed**, después auto-promueve a `notify`.

**Lo que el founder ve cuando approval requerido:**

```
📤 Initial outreach to Sarah Chen — approve?

Channel: X DM
Message:
"Hey Sarah — saw the Series B news 🎉. The SDR ramp problem 
you mentioned is exactly what we obsess over. Made you a 
quick page: spleed.ai/sarah-chen-x7k2. 15 min if it lands?"

Reply: YES / NO / EDIT: <new text>
```

Si `NO`: agente le pregunta por qué (para aprender preferencias del founder a futuro).

**Outputs por tenant:**

Mismo Sarah Chen, mensaje real para 3 founders con tonos distintos:

**Tenant A (casual, B2B SaaS founder):**
> "Hey Sarah! Series B 🚀 congrats. That SDR onboarding tweet hit close to home — built this just for you: spleed.ai/sarah-chen-x7k2. 15 min if it resonates?"

**Tenant B (formal, fintech founder):**
> "Sarah, congratulations on the Series B announcement. Your reflection on SDR ramp time aligns directly with what we've been working on. I prepared a brief overview tailored to Acme's stage: spleed.ai/sarah-chen-x7k2. Would 15 minutes next week make sense?"

**Tenant C (contrarian, devtools founder):**
> "Sarah — most SDR tools won't fix your ramp problem. They're optimized for the wrong thing. Made you a no-bullshit walkthrough of what does: spleed.ai/sarah-chen-x7k2. 15 min, your call."

Mismo lead, 3 mensajes radicalmente distintos. **El tono es del tenant, el research es de Spleed.**

---

## Fase 5 — Engagement Tracking

**Agente:** Outreach Operator (continuous monitoring)

**Trigger:** check cada 24h vía cron, o instant cuando webhook detecta open/reply.

**Branches:**

### Branch A — Reply received

P0 notification al founder INSTANTÁNEA:

```
💬 Sarah Chen replied (X DM, 4 min ago):

"Funny timing — we were JUST talking about this in standup. 
Send me Tuesday options?"

Suggested reply:
"Glad it landed. Cal link: cal.com/founder/15min — 
grab whatever Tuesday works. Looking forward 🙏"

YES / EDIT / I'LL HANDLE IT
```

Si founder responde `I'LL HANDLE IT`, Outreach se pausa para ese lead, founder toma control directo.

### Branch B — Asset opened, no reply (after 48h)

```
👀 Sarah opened your page 3x but hasn't replied.

Multi-channel touch: send LinkedIn DM with different angle?

Suggested LinkedIn DM:
"Sarah — sent you something on X earlier. If LinkedIn is 
better, here it is: spleed.ai/sarah-chen-x7k2. 
No pressure either way."

YES / NO / WAIT
```

### Branch C — No engagement at all (after 96h)

```
🔕 Sarah hasn't engaged. Try different angle?

Option 1: Soft reminder (LinkedIn)
Option 2: Strong angle change (Email — "btw, didn't 
mean to bombard. Read your Series B post and..." 
pivots from product to genuine connection)
Option 3: Skip — move on

Reply 1, 2, or 3
```

### Branch D — Nothing after 14 days, 3 touches

Auto-breakup message:

```
"Sarah, signing off on this. Series B announcement was 
huge, will keep an eye out. Best of luck with the SDR 
journey — page stays up if useful: spleed.ai/sarah-chen-x7k2"
```

Lead marca `lost` con reason `no_response_after_3_touches`.

**Variabilidad por tenant:**

| Tenant style | Tracking aggressiveness |
|---|---|
| Patient (B2B enterprise) | 4 touches over 21 days |
| Aggressive (B2B SMB) | 3 touches over 10 days |
| Conservative (regulated industries) | 2 touches over 14 days |

Configurable in org settings.

---

## Fase 6 — Booking

**Agente:** Outreach Operator + Cal.com integration

**Trigger:** Lead clicks Cal.com link en microsite OR replies confirming meeting.

**Flujo:**

1. Cal.com webhook → Spleed receives `booking.created` event
2. Lead status updates: `booked`
3. Calendar sync: invite agregado al calendar del founder
4. Lead receives confirmation email automatically (vía Cal.com)
5. **Concierge notifies founder via iMessage** (P1):

```
📅 Meeting booked!

Sarah Chen — Tue Jan 22, 2pm EST (15min Zoom)

Briefing for the call:
• Pain: SDR onboarding ramp (3 SDRs in 6 months)
• Recent: Series B announcement Jan 8
• Personal: coffee enthusiast (Costa Rican single-origin)
• Last X activity: posted 4h ago about hiring lead engineer

Open call brief: spleed.ai/brief/sarah-chen-x7k2

Want me to send a pre-meeting gift? Coffee fits her perfectly.
Reply YES to see options, or NO to skip.
```

**Aquí entra el primer punto de gifting decision strategic.**

---

## Fase 7 — Gifting (la fase más estratégica)

**Agente:** Gifter (Sonnet 4.6 + Stripe Issuing)

**Tres timings posibles, cada uno con razones específicas:**

### Timing 1 — Pre-meeting gift (most powerful)

**Cuándo:**
- Meeting está booked
- Strong gift signal (≥0.85 confidence) en dossier
- Lead is high-value (>$10K potential ARR)
- 3+ business days antes del meeting (para que llegue a tiempo)

**Por qué funciona:**
- Crea reciprocity antes del meeting
- Genera "wow, they really did their homework" effect
- Aumenta show-up rate del meeting (15-25% lift según data anecdótica)

**Ejemplo flow Sarah Chen:**

Concierge texta al founder:

```
☕ Pre-meeting gift for Sarah Chen — proposal:

[SCREENSHOT of her tweet about Costa Rican coffee, 3 days ago]

Item: Hacienda La Esmeralda Geisha (Costa Rica origin)
From: Blue Bottle Coffee
Cost: $42 + $8 ship = $50 total
Delivery: Mon Jan 21 (1 day before meeting)
Send to: Acme HQ, 123 Market St, SF

Card text:
"Sarah — saw your CR coffee tweet, couldn't resist.
See you Tuesday. – {{founder.name}}"

The screenshot shows the tweet I'm referencing. 
Approving? YES / NO / EDIT card / DIFFERENT GIFT
```

**Importante: el screenshot del tweet va incluido en el iMessage**. Founder ve la prueba, no solo "she likes coffee".

Si founder responde `YES`:
1. Stripe Issuing emite virtual card por exact $50 + shipping
2. Apify completes Blue Bottle checkout (browser automation, sesión propia de Spleed)
3. Order confirmation tracked
4. Concierge notifies: "Order placed, tracking #BB-12345"
5. Day-of delivery: Concierge confirms "Sarah's coffee just arrived 🙌"

### Timing 2 — Mid-funnel gift (when stuck)

**Cuándo:**
- Lead engaged (opened asset multiple times) but not replying
- Strong gift signal exists
- 7-10 days into outreach sequence
- Founder confidence fit es alto (>0.85)

**Por qué funciona:**
- Unblocks la conversación
- "I noticed you" without being creepy
- Often triggers reply

**Lo que cambia vs pre-meeting:**

```
🤔 Sarah opened the page 3x but no reply for 8 days.

Mid-funnel gift could unblock. Strong signal:

[SCREENSHOT of Costa Rican coffee tweet]

Item: Same Geisha + handwritten note style
Card text:
"Sarah — sending this with no agenda. Saw your coffee 
tweet and figured the world needs more single-origin 
geisha. If our chat ever feels useful, I'm here. 
– {{founder.name}}"

Cost: $50 total
Risk: she could find this weird (she went silent for a reason)
Confidence: 75% positive reception based on dossier

Approve? YES / NO / WAIT MORE
```

**Importante:** Concierge da su `confidence` honesto. Si fuera 50%, lo dice. Founder decide con info real.

### Timing 3 — Post-meeting / Post-deal gift (relationship building)

**Cuándo:**
- Meeting happened, went well (founder marks "good meeting" in app or via Concierge)
- OR deal closed (status = `won`)
- OR specific milestone reached

**Por qué funciona:**
- Cement relationship
- Increases referral likelihood
- "Good service goes beyond the close"

**Ejemplo:**

```
🎉 Sarah signed the contract this morning. 

Post-deal gift suggestion:

[Same coffee or upgrade]

Or option B: book recommendation
"Lean B2B" by [author] — she mentioned wanting to 
study GTM patterns when we last talked.

Both ~$30. Which feels more right?
A / B / NEITHER
```

### Timing 4 — No gifting (when explicitly NOT)

Importante reconocer cuándo NO mandar gift:

- Lead works at compliance-restricted industry (banking, gov, healthcare strict)
- Lead replied negatively to gift hint
- Org budget exhausted this month
- Lead is < $5K potential value (waste of budget)
- Lead has received gift in last 90 days
- gift_signal confidence < 0.7

Concierge auto-skip gifting for these, no notifica.

### Approval flow detallado

**Para CUALQUIER gift, el flujo es:**

```
1. Gifter constructs proposal (item, cost, address, message)
   ↓
2. Captures product screenshot vía Apify
   ↓
3. Creates approval_request row, status=pending
   ↓
4. Emits Concierge event P1 with full payload
   ↓
5. Concierge formats iMessage with:
   • Lead context (1 line)
   • Gift signal screenshot (image attached)
   • Product info + screenshot (image attached)
   • Cost breakdown
   • Suggested card text
   • Honesty about risk/confidence
   • YES/NO/EDIT prompt
   ↓
6. Founder responds via iMessage
   ↓
7. Concierge parses response, calls resolve_approval()
   ↓
8. If YES:
   - Stripe Issuing emits virtual card (exact amount, MCC allowlist, 24h expiry)
   - Apify or browser automation completes checkout
   - Updates gift status: purchasing → purchased
   - Schedules notify_lead_post_shipping for delivery date + 1
   ↓
9. Day of delivery: Concierge confirms delivery, asks for follow-up
```

---

## Concierge: la capa conversacional bidireccional

Concierge es el **único** punto de contacto entre Spleed y el founder. Los otros 5 agentes nunca tocan iMessage directamente.

### Inbound capabilities (founder texts Concierge)

**Querying state:**
- "how's outreach to acme going?"
- "show me sarah's dossier"
- "what's pending approval?"
- "stats this week"
- "best lead today"

**Commanding actions:**
- "skip sarah she just left the company"
- "pause outreach to all acme leads"
- "send the gift to tom"
- "switch sarah to email channel"
- "mark beta as won"

**Configuring:**
- "stop pinging me about gifts under $30"
- "quiet hours all day saturday, my wife's birthday"
- "switch to terse mode"
- "increase gift budget to $400"

**Conversational:**
- "any reply from sarah yet?"
- "remind me what I told tom last week"
- "what was the costa rica coffee guy's name?"

### Outbound capabilities (Concierge initiates)

Solo emite con priority defined:

**P0 — Always interrupt (incluido quiet hours):**
- Reply received que necesita acción <1h
- Stripe Issuing transaction failed mid-flight
- Critical error in any agent
- Lead replied with "remove me" / unsubscribe (compliance)

**P1 — Notify within hour, respect quiet hours:**
- Approval needed (gift, sensitive outreach)
- Meeting booked
- Asset published to high-fit lead (>0.85)
- High-fit lead enriched

**P2 — Daily digest:**
- Routine activity
- Stats and trends
- Pending actions summary

### Anti-hallucination con screenshots

**Regla absoluta:** cuando Concierge cita data específica de un lead, **adjunta screenshot del source**.

Ejemplos:
- Cita un tweet → screenshot del tweet
- Cita un LinkedIn post → screenshot del post
- Propone gift basado en signal → screenshot del signal source
- Reporta engagement (lead opened asset) → screenshot del tracking event en dashboard

**Por qué crítico:**
1. Founder confía en el dato
2. Si el agente alucinó, founder lo cacha viendo el screenshot
3. Si el agente acertó, founder se impresiona y aprueba sin fricción

**Cuándo NO necesita screenshot:**
- Stats agregadas ("12 leads enriched today")
- Estado de sistema ("Scout completed")
- Acciones del founder mismo ("you approved the gift to sarah")

### Memoria conversacional

Concierge tiene context window de últimos 200 mensajes + memoria comprimida.

```
Founder: "send the costa rica guy a follow up"
Concierge: [resolves "costa rica guy" = Sarah Chen vía recent context]
           "Sarah Chen at Acme? Last touch was the coffee 4 days ago. 
           She replied 'thanks, swamped this week'. Suggesting wait 
           3 more days. Or send something now? Reply NOW or WAIT."
```

Si la referencia es ambigua:
```
Founder: "send him a follow up"
Concierge: "Multiple recent threads. Did you mean:
           1. Tom Park at Beta (last replied 2d ago)
           2. Mike Chen at Gamma (no reply for 5d)
           Reply 1 or 2."
```

### Format rules

- **Length:** max 4 lines for queries, 8 for digests
- **No markdown:** iMessage doesn't render bold/italic
- **Times:** founder timezone, relative when possible ("in 2h", "tomorrow 3pm")
- **Names:** first name + company shorthand ("Sarah at Acme")
- **One question per message:** never two
- **Multi-bubble:** if >800 chars, split at sentence boundary
- **Emojis:** match founder style. If founder uses 🔥, OK. If never, never.

---

## Outputs por tenant: variabilidad real

Mismo flujo, outputs muy distintos según el tenant. Tres ejemplos completos:

### Tenant A — B2B SaaS Founder (casual tone, Series A targeting)

**Discovery:** 50 leads/day Apollo-heavy, focus en VPs of GTM
**Profiler:** dossiers casuales, captura más signals de X que LinkedIn
**Composer:** microsites con copy directo, emojis, mono fonts
**Outreach:** primero X DM, fallback email, NO LinkedIn (overfished)
**Tracking:** 3 touches en 10 días
**Gifting:** Pre-meeting only, $40-60 budget, items cool/curated
**Concierge:** terse mode, 2-3 línea responses

### Tenant B — B2B Fintech Founder (formal tone, regulated industry)

**Discovery:** 30 leads/day, focus en CFOs/Treasurers, Apollo + Crunchbase
**Profiler:** signals desde LinkedIn principalmente, evita X (pocos en CFO ICP)
**Composer:** microsites profesionales, full sentences, numbers heavy (ROI)
**Outreach:** email primary, LinkedIn secondary, NO X
**Tracking:** 4 touches en 21 días (longer cycle)
**Gifting:** Cuidadoso con compliance — books, donations to nominated charity, NEVER alcohol/expensive
**Concierge:** detailed mode, full context per query

### Tenant C — Pre-seed Devtools Founder (contrarian tone)

**Discovery:** 80 leads/day GitHub-heavy, focus en engineers + technical leads
**Profiler:** GitHub commits, HN comments, technical blog posts
**Composer:** microsites con code samples, hot takes, no buzzwords
**Outreach:** GitHub via issue/discussion, X DM, email (NO LinkedIn — devs don't check)
**Tracking:** 2 aggressive touches en 7 days, then move on
**Gifting:** Mechanical keyboards, niche dev books, espresso gear (not coffee, espresso)
**Concierge:** super terse, dry humor allowed, "lol" acceptable in responses

---

## Edge cases y modos de fallo

### Edge case 1 — Lead identidad equivocada

Profiler detecta que "Tom Cook at Acme" puede ser 2 personas distintas (mismo nombre).

```
⚠️ Mistaken identity risk for Tom Cook at Acme.

Found 2 possible profiles:
1. Tom Cook, VP Sales at Acme (LinkedIn match 87%)
2. Tom Cook, CTO at Acme (LinkedIn match 73%)

Acme on LinkedIn lists both. Which one matches your ICP?
Reply 1 or 2.
```

### Edge case 2 — Sendblue iMessage falla

Sendblue down, Concierge no puede mandar iMessage. Failover automático a email con misma estructura. Si email también falla, Concierge logs critical error, espera retry.

### Edge case 3 — Stripe Issuing transaction fails mid-checkout

Apify completes checkout pero Stripe declines virtual card (fraud detection). Gifter:
1. Cancels purchase intent
2. P0 notification to founder: "Stripe declined the card. Probably fraud check. Want me to retry with new card or skip?"
3. Founder responds, agent acts.

### Edge case 4 — Lead replies negatively to gift

```
"Please don't send me anything. Strict company policy."
```

Concierge:
1. Marca lead with `gift_eligible = false` permanently
2. Notifies founder: "Sarah at Acme says no gifts (company policy). Marking as no-gift. Continuing outreach normally?"
3. Continues outreach without gifts

### Edge case 5 — Founder doesn't respond to approval in 24h

Approval expires. Gifter:
1. Sets gift status: `expired`
2. Concierge digest: "3 approvals expired yesterday — want to revisit or skip?"
3. Founder can re-trigger from web dashboard

### Edge case 6 — Apify rate limit / cuota mensual exhausted

Profiler returns thin dossier. Concierge:
1. Notifies founder P1: "Apify quota nearly exhausted. Profiler running on Tier 1 only (no X/GitHub/Reddit). Quality may degrade. Top up Apify?"
2. Founder responds, decides.

### Edge case 7 — Lead at compliance-restricted company

Profiler detects company in `compliance_restricted` list (banks, gov, healthcare strict). Notifies in dossier. Gifter:
1. Auto-suggests $0 alternative (handwritten note PDF, donation to charity in lead's name)
2. Concierge: "Sarah works at JPMorgan — strict gift policy. Suggest a $0 alternative: donation to a cause or handwritten note? Or skip?"

---

## Métricas críticas (qué medir desde día 1)

Por tenant:
- **Discovery quality:** % leads con fit_score > 0.8
- **Enrichment depth:** avg dossier confidence_score
- **Compose conversion:** % microsites con engagement
- **Outreach reply rate:** target >8%
- **Gifting ROI:** meetings booked attributable a gifts / gift cost
- **Concierge response time:** founder→Concierge reply latency p95
- **Approval rate:** % approvals approved vs rejected (target >70%)
- **Founder NPS proxy:** weekly digest "rate this week" 1-5

---

## Fin del flujo E2E

Este documento es referencia para Claude Code en sprints 5-8 (cuando construyas los agentes). Es lo más detallado que necesita.

Versión: 0.3
Última actualización: pre-Sprint 0
Owner: Felipe (founder)
