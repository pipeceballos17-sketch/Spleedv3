# Spleed — CLAUDE.md Patch v0.3

> Este es un PATCH al `CLAUDE.md` master. Aplícalo manualmente cuando armes el repo.
> 
> **Cambios v0.3:**
> 1. Agrega principio ético "professional/business signals only" en sección 3 (filosofía)
> 2. Agrega referencia al `BACKLOG.md` en el header de docs
> 3. Agrega nota sobre Concierge como punto único de iMessage

---

## Cambio 1 — En el header de docs (al inicio del archivo)

**Reemplaza el bloque actual de "Reference docs en este repo" con este:**

```markdown
> **Reference docs en este repo (lee bajo demanda, no todo de una):**
> - `/docs/v02-patch.md` — Concierge agent + iMessage HITL bidireccional + browser strategy MVP
> - `/docs/agents/agent-prompts.md` — System prompts de los 5 agentes operacionales (Scout, Profiler, Composer, Outreach, Gifter) + Concierge
> - `/docs/db/schema-spec.md` — Schema completo Drizzle ORM (referencia para implementar /packages/db)
> - `/docs/db/rls-spec.sql` — RLS policies + helper functions (aplicar después de migrations)
> - `/docs/db/isolation-test-spec.md` — Test crítico de aislamiento multi-tenant (CI bloqueante)
> - `/docs/e2e-flow-spec.md` — Flujo end-to-end completo (discovery → gifting), Concierge bidirectional, screenshots anti-hallucination, variabilidad por tenant
> - `/BACKLOG.md` — Items diferidos a sprints específicos. Antes de empezar un sprint, revisa items aplicables.
>
> **Cuando ejecutes una tarea, primero pregunta qué docs son relevantes y léelos antes de codear.**

---
```

---

## Cambio 2 — Agregar a la sección 3 "Filosofía de arquitectura" (al final de la sección)

**Después de "Human-in-the-loop como first-class citizen", agregar este bloque nuevo:**

```markdown
### Principio ético: professional/business signals only

Spleed enriquece leads con data pública pero opera con un límite explícito: **solo signals professional/business, nunca personal/private content**.

**Esto significa:**

- **SÍ scraping:** LinkedIn (full), X/Twitter (cuentas profesionales), GitHub, Hacker News, Substack (escritos), podcasts donde aparezcan, personal websites con contenido profesional, conferences donde hayan hablado.

- **NO scraping** (ni en MVP ni Phase 2):
  - Familia, hijos, parejas (incluso si son públicos)
  - Health/wellness vulnerable
  - Política/religión
  - Affiliations privadas (gym, club)
  - Personal celebrations (cumpleaños familiar, vacaciones)
  - Cualquier contenido que el lead probablemente NO compartiría con un sales prospect

**Implicaciones para los agentes:**

- **Profiler** filtra signals durante enrichment. Si encuentra contenido "personal" lo descarta, no lo persiste. Solo persiste lo que el lead probablemente publicaría en un currículum o pitch profesional.

- **Composer** y **Outreach** NUNCA citan contenido personal en outreach, aunque el dato esté en el dossier por error. Regla: si el lead se sentiría incómodo viendo la cita, no se cita.

- **Gifter** propone gifts basados en signals professional (passion específico, hobby compartido públicamente como parte de identidad pro), nunca basados en personal life.

**Por qué este límite importa:**

1. **Brand:** Spleed se posiciona como "ethical AI sales co-founder". Cruzar la línea daña marca permanentemente.
2. **Compliance:** Más fácil aprobación enterprise (GDPR, CCPA) sin contenido personal.
3. **Conversion:** Outreach que cita contenido demasiado personal genera "creep factor" → reduce conversion.
4. **Sustainability:** Empresas como LinkedIn/X/IG eventualmente bloquearán scrapers agresivos. Limitarse a contenido pro reduce risk de baneo.

**Excepción única:** gift signals como "she tweeted she loves Costa Rican coffee" SÍ se usan, porque el lead lo publicó como parte de su identidad pública. NO se usaría "she Instagrammed her family vacation in Costa Rica" — eso es personal.

Este principio es **NO-NEGOTIABLE** y se aplica a todos los agentes en todos los sprints.
```

---

## Cambio 3 — Reforzar en sección 6 (iMessage HITL)

**Agregar al final de la sección "iMessage HITL flow (Sendblue)":**

```markdown
### Concierge es el ÚNICO punto de contacto vía iMessage

**Regla absoluta:** ningún otro agente (Scout, Profiler, Composer, Outreach, Gifter) toca Sendblue directamente. Solo emiten eventos con priority. Concierge es el único que decide qué notificar y cómo.

**Por qué:**
- Evita spam: 6 agentes mandando iMessages independientemente = ruido
- Tone consistency: un solo agente = una sola voz
- Un solo punto de coordinación: respect quiet hours, batch en digest, etc.
- Easier to debug: tracking de iMessage en un solo lugar

**Capabilities expandidas de Concierge (referenciar BACKLOG-004):**

Concierge no solo NOTIFICA, también RECIBE comandos del founder:
- Manual lead enrichment via URL (founder texta LinkedIn URL → Concierge encola Profiler)
- State queries (founder pregunta sobre leads)
- Commands (skip, pause, reassign)
- Approval responses (YES, NO, EDIT)
- Configuration changes (quiet hours, gift budget)

**Lo que NO hace Concierge:**
- Voice messages bidireccionales (rejected, ver BACKLOG-008)
- Screenshot enrichment (Phase 2, ver BACKLOG-006)
- Pfps en mensajes (Phase 2, ver BACKLOG-003)
```

---

## Cómo aplicar este patch

Cuando armes el repo (próximo paso), después de pegar el `CLAUDE.md` master en raíz:

1. Abre `CLAUDE.md` con tu editor
2. Aplica Cambio 1: reemplaza el header de docs con la versión nueva (incluye `BACKLOG.md`)
3. Aplica Cambio 2: agrega el bloque "Principio ético" al final de sección 3
4. Aplica Cambio 3: agrega los bloques al final de sección 6
5. Guarda y commitea como parte del bootstrap inicial

El `BACKLOG.md` va en raíz también (hermano de `CLAUDE.md`).

---

**Versión patch:** 0.3
**Owner:** Felipe
