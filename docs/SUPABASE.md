# Supabase notes

The API uses Supabase purely as a **PostgreSQL database, accessed over PostgREST**
with `@supabase/supabase-js`. There is no ORM, no connection string and no
connection pool.

Supabase Auth, Supabase Storage and the browser client are all unused: this API
issues its own JWTs, and images go to Cloudinary.

---

## Configuration

Two variables, both from **Dashboard → Project Settings → API**:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_…
```

The secret (service-role) key bypasses RLS. That is correct here because
authorisation lives in this API's JWT + role middleware, and the key never leaves
the server. **Never expose it to a browser.**

Verify with:

```bash
curl http://localhost:4000/api/health/db
```

---

## Schema

18 tables, already provisioned. The API does not migrate anything at runtime, so
schema changes are made in the Supabase SQL editor.

When adding a column the API should read or write, add it there first — PostgREST
picks it up from its schema cache automatically.

---

## The one security step still outstanding

Supabase publishes **every table in the `public` schema** through PostgREST at
`https://<project>.supabase.co/rest/v1/`, authorised by the **anon key** — which is
public by design and ships inside frontend bundles.

This backend removed RLS when it replaced Supabase Auth, so that door is currently
open: anyone with the anon key can read `contact_leads`, `service_surveys` and
`users` directly, bypassing every check the API makes.

**Do not close it yet if your live site still reads Supabase directly** — revoking
anon access would take the site down. Once the frontend points at this API, run the
following in the Supabase SQL editor:

```sql
-- Revoke PostgREST access from the public-facing roles
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all privileges on table public.%I from anon', t);
    execute format('revoke all privileges on table public.%I from authenticated', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

revoke usage on schema public from anon, authenticated;

-- Keep anything created later locked down too
alter default privileges in schema public revoke all on tables from anon, authenticated;
```

Your API is unaffected: the service-role key is not `anon`.

Confirm it worked — this should return zero rows:

```sql
select table_name, grantee from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');
```

---

## Operational notes

**No transactions.** PostgREST exposes no multi-statement transactions. Reorder
works around this with a single atomic upsert; relation syncing (case-study credits,
showcase placements) is delete-then-insert, which on failure leaves the parent with
none rather than duplicates.

**Free-tier pausing.** Supabase pauses free projects after ~7 days idle; the first
request then fails until it resumes from the dashboard. Worth ruling out before
blaming the API.

**Schema cache.** If a freshly added table returns `PGRST205`, PostgREST has not
reloaded its cache yet — it refreshes shortly, or you can reload it from the
dashboard.
