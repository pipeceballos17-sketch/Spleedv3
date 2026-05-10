# Runbook: Supabase Project Setup

One-time setup for each Supabase environment (local dev, hosted production when ready).

## Local dev (recommended for Sprint 1+)

Prerequisite: Docker Desktop running with WSL2 integration enabled. Confirmed via `docker ps` returning successfully.

### 1. Install Supabase CLI

```bash
# Inside WSL Ubuntu
curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
  | tar -xz
sudo mv supabase /usr/local/bin/
supabase --version
```

### 2. Initialize Supabase project (once per repo)

```bash
cd /home/felipe/Code/spleed
supabase init
```

This creates `supabase/config.toml`. Commit it.

### 3. Configure the Custom Access Token Hook

Edit `supabase/config.toml` and add:

```toml
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token_hook"
```

(The hook function itself is created by `bun run db:migrate`. This config tells Supabase Auth to call it on every JWT issuance.)

### 4. Start the Supabase stack

```bash
supabase start
```

Boots Postgres (port 54322), Auth (port 54321), Storage, Realtime, etc. in Docker. First start downloads images (~1–2 GB).

Output prints credentials. Copy these into `.env.local`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=<from output>
SUPABASE_SERVICE_ROLE_KEY=<from output>
SUPABASE_JWT_SECRET=<from `supabase status`, "JWT secret" line>
```

If you missed the boot output, run `supabase status` anytime to reprint.

### 5. Apply schema, RLS, and seed

```bash
bun run db:generate    # only if schema/*.ts changed since last generate
bun run db:migrate     # tables + RLS + helpers + hooks + bootstrap
bun run db:seed        # agent_templates stubs
```

### 6. Verify

```bash
bun run test:db
```

Should run the isolation suite, all green. If `JWT signature verification failed` errors: confirm `SUPABASE_JWT_SECRET` matches what `supabase status` reports.

## Hosted production setup (later, when ready)

Same steps with these adjustments:

- `supabase link --project-ref <ref>` to link to the hosted project
- `.env.local` (or production env vars) point at hosted URLs and keys
- Custom Access Token Hook is enabled in the **Dashboard**, not via `config.toml`:
  Authentication → Hooks → Customize Access Token (CAT) → Enable → Postgres → Schema `public` → Function `custom_access_token_hook` → Save
- Migrations apply via `bun run db:migrate` against the production `DATABASE_URL`
- `db:reset` will refuse to run against non-local hosts — this is intentional

## Troubleshooting

### `supabase start` fails: port already in use

Another process owns 54321 or 54322. Stop it (`lsof -i :54322`) or change the ports in `supabase/config.toml`.

### `db:migrate` fails: relation already exists

Re-running migrate after success is fine — RLS files are idempotent. If table conflicts appear, the drizzle migration log got out of sync. Run `bun run db:reset` (local only — drops the public schema) and re-migrate.

### Isolation tests fail with `JWT signature verification failed`

Local Supabase prints a fixed JWT_SECRET at boot. Re-export it to `.env.local`. If you restarted Docker, the secret may have rotated — `supabase status` is the source of truth.

### Custom Access Token Hook not firing

After `supabase start`, JWTs should include `org_id` once a user has an `org_members` row. To verify:

1. Sign up a test user via Supabase Auth
2. Manually run `bootstrap_user_org(...)` via psql (or call from API)
3. Sign in again or call `supabase.auth.refreshSession()` from the client
4. Decode the new access token (jwt.io); claims should include `org_id` and `org_role`

If `org_id` is missing, the hook isn't enabled. Check `supabase/config.toml` and restart with `supabase stop && supabase start`.
