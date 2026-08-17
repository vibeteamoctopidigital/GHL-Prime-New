-- ============================================================================
-- Supabase hardening for the GHL Prime backend
--
-- Run this ONCE in the Supabase dashboard (SQL Editor → New query → Run),
-- AFTER `npx prisma db push` has created the tables.
--
-- WHY THIS IS NOT OPTIONAL
-- ------------------------
-- Supabase automatically exposes every table in the `public` schema through
-- PostgREST at https://<ref>.supabase.co/rest/v1/, authorised by the `anon`
-- API key. That key is public by design — it ships inside frontend bundles.
--
-- This backend no longer uses RLS: authorisation moved into the API layer
-- (JWT + role middleware) when Supabase Auth was replaced. That is fine for
-- traffic arriving through the API, but it means the PostgREST door must be
-- shut explicitly. Otherwise anyone holding the anon key could read
-- `contact_leads` and `service_surveys` (lead PII) or `users` (password
-- hashes) directly, completely bypassing the API.
--
-- This script closes that door three ways:
--   1. Revokes all table privileges from `anon` and `authenticated`.
--   2. Enables RLS with no policies, so those roles are denied even if a
--      future grant slips through. (The table owner — the `postgres` role your
--      backend connects as — bypasses RLS, so the API is unaffected.)
--   3. Sets DEFAULT PRIVILEGES so tables created by a later `prisma db push`
--      are locked down automatically instead of inheriting Supabase's
--      permissive defaults.
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke PostgREST access from the public-facing roles
-- ---------------------------------------------------------------------------
do $$
declare
  target_table text;
begin
  for target_table in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('revoke all privileges on table public.%I from anon', target_table);
    execute format('revoke all privileges on table public.%I from authenticated', target_table);
  end loop;
end $$;

revoke usage on schema public from anon;
revoke usage on schema public from authenticated;

revoke all privileges on all sequences in schema public from anon;
revoke all privileges on all sequences in schema public from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS with no policies — deny by default for every non-owner role
--
-- The backend connects as the table owner, which bypasses RLS, so this is
-- defence in depth rather than something the API has to work around.
-- ---------------------------------------------------------------------------
do $$
declare
  target_table text;
begin
  for target_table in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', target_table);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Lock down anything created later (e.g. by a future `prisma db push`)
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on sequences from authenticated;

-- ---------------------------------------------------------------------------
-- 4. Verify — every row should read rls_enabled = true, with 0 for anon and
--    authenticated. Anything else means a grant survived.
-- ---------------------------------------------------------------------------
select
  t.tablename,
  t.rowsecurity as rls_enabled,
  count(*) filter (where g.grantee = 'anon')          as anon_grants,
  count(*) filter (where g.grantee = 'authenticated') as authenticated_grants
from pg_tables t
left join information_schema.role_table_grants g
  on g.table_name = t.tablename
 and g.table_schema = 'public'
 and g.grantee in ('anon', 'authenticated')
where t.schemaname = 'public'
group by t.tablename, t.rowsecurity
order by t.tablename;
