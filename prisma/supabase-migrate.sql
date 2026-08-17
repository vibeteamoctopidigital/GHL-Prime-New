-- ============================================================================
-- GHL Prime — bring the EXISTING Supabase database up to the backend schema
--
-- Project: iyxepkllkqwkwapdzstj
-- Run ONCE in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THIS SCRIPT IS PURELY ADDITIVE. It never drops a table, a column, or a row.
-- ────────────────────────────────────────────────────────────────────────────
--
-- WHY NOT `prisma db push`?
-- Because push reconciles the database *to* the schema, which means dropping
-- anything the schema does not describe. Your live tables carry two legacy
-- columns (partner_logos.name and partner_logos.logo_image_url) that push would
-- remove. They are empty today, but "empty today" is not a good enough reason
-- to let an automated tool drop columns from a production database. Prisma
-- ignores columns it does not know about, so leaving them costs nothing.
--
-- Verified against the live database before writing this:
--
--   TABLE                     ROWS   STATUS
--   blog_posts                  50   matches the schema exactly
--   case_studies                17   matches
--   case_study_team_members      0   matches
--   gallery_categories           1   matches
--   gallery_images               3   matches
--   meeting_gallery             10   matches
--   partner_logos               19   data is in company_name + image_url ✓
--   showcase_items              16   matches
--   showcase_placements         64   matches
--   showcase_stats               4   matches
--   team_members                 2   matches
--   team_page_members           12   needs 2 new columns (added below)
--   technology_logos            21   matches
--
-- Everything this script adds: 2 enums, 5 new tables, 2 columns, and indexes.
-- Safe to re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type "UserRole" as enum ('ADMIN', 'EDITOR', 'VIEWER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type "LeadStatus" as enum ('NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST', 'ARCHIVED');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- 2. Columns missing from team_page_members
--    The 12 existing rows keep their data; both columns take a default.
-- ---------------------------------------------------------------------------
alter table public.team_page_members
  add column if not exists published boolean not null default true;

alter table public.team_page_members
  add column if not exists updated_at timestamptz(6) not null default current_timestamp;


-- ---------------------------------------------------------------------------
-- 3. Authentication (replaces Supabase Auth)
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  full_name     text,
  role          "UserRole" not null default 'EDITOR',
  is_active     boolean not null default true,
  last_login_at timestamptz(6),
  created_at    timestamptz(6) not null default current_timestamp,
  updated_at    timestamptz(6) not null default current_timestamp
);

create unique index if not exists users_email_key on public.users(email);
create index if not exists users_email_idx on public.users(email);

create table if not exists public.refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  token_hash text not null,
  user_id    uuid not null,
  expires_at timestamptz(6) not null,
  revoked_at timestamptz(6),
  user_agent text,
  ip_address text,
  created_at timestamptz(6) not null default current_timestamp
);

create unique index if not exists refresh_tokens_token_hash_key on public.refresh_tokens(token_hash);
create index if not exists refresh_tokens_user_id_idx on public.refresh_tokens(user_id);
create index if not exists refresh_tokens_expires_at_idx on public.refresh_tokens(expires_at);

do $$ begin
  alter table public.refresh_tokens
    add constraint refresh_tokens_user_id_fkey
    foreign key (user_id) references public.users(id) on delete cascade on update cascade;
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- 4. Contact leads
--    Absent from this project, so the contact form had nowhere to store
--    submissions. Created here with every field the multi-step form collects.
-- ---------------------------------------------------------------------------
create table if not exists public.contact_leads (
  id                uuid primary key default gen_random_uuid(),
  full_name         text,
  email             text,
  phone             text,
  company           text,
  message           text,
  source            text,
  country           text,
  role              text,
  ghl_situation     text,
  client_volume     text,
  monthly_budget    text,
  timeline          text,
  biggest_challenge text,
  page_url          text,
  status            "LeadStatus" not null default 'NEW',
  notes             text,
  submitted_at      timestamptz(6) not null default current_timestamp,
  created_at        timestamptz(6) not null default current_timestamp,
  updated_at        timestamptz(6) not null default current_timestamp
);

create index if not exists contact_leads_email_idx on public.contact_leads(email);
create index if not exists contact_leads_status_idx on public.contact_leads(status);
create index if not exists contact_leads_submitted_at_idx on public.contact_leads(submitted_at desc);


-- ---------------------------------------------------------------------------
-- 5. Service-page survey submissions
-- ---------------------------------------------------------------------------
create table if not exists public.service_surveys (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  email         text,
  phone         text,
  business      text,
  service       text,
  source        text,
  role          text,
  business_type text,
  stage         text,
  app_type      text,
  needs         text,
  budget        text,
  sub_accounts  text,
  lead_volume   text,
  coverage      text,
  details       text,
  page_url      text,
  status        "LeadStatus" not null default 'NEW',
  notes         text,
  submitted_at  timestamptz(6) not null default current_timestamp,
  created_at    timestamptz(6) not null default current_timestamp,
  updated_at    timestamptz(6) not null default current_timestamp
);

create index if not exists service_surveys_email_idx on public.service_surveys(email);
create index if not exists service_surveys_service_idx on public.service_surveys(service);
create index if not exists service_surveys_status_idx on public.service_surveys(status);
create index if not exists service_surveys_submitted_at_idx on public.service_surveys(submitted_at desc);


-- ---------------------------------------------------------------------------
-- 6. Uploaded images (Cloudinary)
-- ---------------------------------------------------------------------------
create table if not exists public.media_assets (
  id                uuid primary key default gen_random_uuid(),
  public_id         text not null,
  url               text not null,
  secure_url        text not null,
  format            text,
  resource_type     text,
  width             integer,
  height            integer,
  bytes             integer,
  folder            text,
  original_filename text,
  alt               text,
  tags              text[] default array[]::text[],
  uploaded_by_id    uuid,
  created_at        timestamptz(6) not null default current_timestamp,
  updated_at        timestamptz(6) not null default current_timestamp
);

create unique index if not exists media_assets_public_id_key on public.media_assets(public_id);
create index if not exists media_assets_created_at_idx on public.media_assets(created_at desc);
create index if not exists media_assets_folder_idx on public.media_assets(folder);

do $$ begin
  alter table public.media_assets
    add constraint media_assets_uploaded_by_id_fkey
    foreign key (uploaded_by_id) references public.users(id) on delete set null on update cascade;
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- 7. Indexes the schema expects on the existing tables (all `if not exists`)
-- ---------------------------------------------------------------------------
create index if not exists case_studies_published_idx     on public.case_studies(published);
create index if not exists team_page_members_sort_order_idx on public.team_page_members(sort_order);


-- ---------------------------------------------------------------------------
-- 8. Verify — expect 18 rows, and the row counts you started with.
-- ---------------------------------------------------------------------------
select
  c.relname as table_name,
  c.reltuples::bigint as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
