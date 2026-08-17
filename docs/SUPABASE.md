# Using Supabase as the database

This backend is database-agnostic Postgres — moving from Neon to Supabase is a
connection-string change plus one security script. No application code changes.

> **What Supabase hosts:** the PostgreSQL database. It does **not** host Node or
> Express apps (its Edge Functions are Deno). The API itself still runs on
> Vercel — see [DEPLOYMENT.md](DEPLOYMENT.md). Supabase Auth, Storage and the
> Supabase JS client are all unused: authentication is JWT in the API layer, and
> images go to Cloudinary.

---

## 1. Create the project

1. [database.new](https://database.new) → new project.
2. Save the database password — Supabase shows it once.
3. Pick the region closest to your Vercel deployment region; every query pays
   that round trip.

## 2. Get the connection strings

Dashboard → **Connect** (or *Project Settings → Database → Connection string*).
You need two, and they are not interchangeable:

| Purpose | Which one | Port |
|---|---|---|
| `DATABASE_URL` — the API at runtime | **Transaction pooler** | `6543` |
| `DIRECT_URL` — `prisma db push` / `migrate` only | **Session pooler** | `5432` |

```bash
# DATABASE_URL — note the two query parameters, both required
postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1

# DIRECT_URL
postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Why `pgbouncer=true` is mandatory.** The transaction pooler hands your
connection to a different backend between statements, so it cannot hold prepared
statements. Prisma uses them by default. Without this flag you get intermittent,
maddening `prepared statement "s0" already exists` errors under load — the kind
that pass every local test and only appear in production.

**Why `DIRECT_URL` cannot use 6543.** Migrations need a real session (advisory
locks, DDL transactions). The transaction pooler cannot provide one.

URL-encode special characters in the password: `@` → `%40`, `#` → `%23`,
`$` → `%24`, `&` → `%26`.

## 3. Configure `.env`

The complete list is in [`.env.supabase.example`](../.env.supabase.example) —
copy it and fill in the blanks. The essentials:

```bash
DATABASE_URL="postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres"
```

> You do **not** need `SUPABASE_URL`, `SUPABASE_ANON_KEY` or
> `SUPABASE_SERVICE_ROLE_KEY`. This backend speaks Postgres directly through
> Prisma. Those keys only open access paths that step 5 deliberately closes.

## 4. Create the tables

```bash
cd backend
npx prisma db push     # creates all 18 tables
npm run db:seed        # admin user + content (idempotent)
```

`db:seed` upserts on natural keys, so re-running converges rather than
duplicating.

## 5. Close the PostgREST door — do not skip this

Supabase automatically publishes **every table in the `public` schema** through
PostgREST at `https://<ref>.supabase.co/rest/v1/`, authorised by the `anon` API
key — which is public by design and ships inside frontend bundles.

This backend removed RLS when it replaced Supabase Auth; authorisation now lives
in the API layer. That is correct for traffic through the API, but it means the
PostgREST door must be shut explicitly. Otherwise anyone with the anon key can
read `contact_leads` and `service_surveys` (lead PII) or `users` (password
hashes) directly, bypassing every check the API makes.

**Run [`prisma/supabase-setup.sql`](../prisma/supabase-setup.sql) once** in the
Supabase SQL Editor. It revokes `anon`/`authenticated` grants, enables RLS with
no policies as a second line of defence, and sets default privileges so tables
created by a future `prisma db push` are locked down automatically.

Your API is unaffected: it connects as the table owner, which bypasses RLS.

## 6. Verify

```bash
npm run db:check
```

Validates both URLs, proves connectivity, confirms all 18 tables, reports row
counts, and — on Supabase — checks that no `anon`/`authenticated` grants remain:

```
═══ Supabase exposure check ═══
  ✓ no anon/authenticated grants — PostgREST cannot reach these tables
  ✓ row level security enabled on every table (defence in depth)
```

If it reports tables still readable, step 5 did not run.

---

## Moving existing data from Neon

`npm run db:seed` recreates content that comes from the frontend data modules,
but **not** rows created since — contact leads, service surveys and uploaded
media records exist only in the database. Copy those across rather than losing
them.

```bash
# 1. Dump the Neon database (schema + data), excluding owner/ACL noise
pg_dump "postgresql://<neon-direct-url>" \
  --no-owner --no-privileges --clean --if-exists \
  -f ghlprime-backup.sql

# 2. Restore into Supabase over the SESSION pooler (port 5432, not 6543)
psql "postgresql://postgres.[REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres" \
  -f ghlprime-backup.sql

# 3. Re-run the hardening script — a restore re-creates tables with
#    Supabase's permissive default grants
#    (paste prisma/supabase-setup.sql into the SQL Editor)

# 4. Confirm
npm run db:check
```

`pg_dump` must be version 15+ to match Supabase's server. If yours is older,
`npx prisma db push` followed by `npm run db:seed` gets you a working database
without the accumulated leads.

To copy only the lead tables, add
`--table=contact_leads --table=service_surveys --table=media_assets --data-only`
to the dump.

---

## Deploying with Vercel

Set the same two variables in **Vercel → Settings → Environment Variables**,
alongside the rest from [DEPLOYMENT.md](DEPLOYMENT.md) §3.

The transaction pooler matters more on Vercel than locally: each serverless
instance opens its own connection, and a direct connection would exhaust the
limit under traffic. `connection_limit=1` plus the pooler is the combination
that holds up.

Migrations still run from your machine — Vercel does not run them:

```bash
DATABASE_URL="<pooler-6543>" DIRECT_URL="<session-5432>" npx prisma db push
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `prepared statement "s0" already exists` | `pgbouncer=true` missing from `DATABASE_URL`. Add it. |
| `Can't reach database server` from your machine | The direct host (`db.<ref>.supabase.co`) is IPv6-only on newer projects. Use the **session pooler** host for `DIRECT_URL`. |
| `db push` hangs or errors on advisory locks | `DIRECT_URL` is pointing at port 6543. Migrations need 5432. |
| `password authentication failed` | Special characters in the password are not URL-encoded. |
| `Max client connections reached` | Runtime is not using the 6543 pooler, or `connection_limit` is unset. |
| API works, but data is visible via `https://<ref>.supabase.co/rest/v1/...` | `supabase-setup.sql` has not been run. Run it, then `npm run db:check`. |
| `Tenant or user not found` | The pooler username must be `postgres.[PROJECT-REF]`, not plain `postgres`. |

Supabase pauses free-tier projects after ~7 days idle; the first request then
fails until it resumes from the dashboard. Worth knowing before blaming the API.

---

## Neon vs Supabase

Both are managed Postgres and the backend runs identically on either.

| | Neon | Supabase |
|---|---|---|
| Pooling | Built into the `-pooler` host | Supavisor, separate port (6543) |
| Prisma extra config | none | `pgbouncer=true` required |
| Auto REST API | none | PostgREST on every `public` table — must be locked down |
| Free tier idling | scale-to-zero, auto-resumes | pauses after ~7 days, manual resume |

Supabase's auto-generated REST API is the one meaningful operational difference,
and step 5 is what neutralises it.
