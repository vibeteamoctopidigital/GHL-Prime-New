# Auto Blog (AI blog publishing)

Generates SEO-optimized `blog_posts` rows using a connected Claude
subscription (and optionally a ChatGPT/Codex subscription), on a schedule
or on demand — with live topic research, an admin review window, an
automated second-opinion check, AI-generated cover images, and email
alerts on failure.

**Generation runs through the `claude`/`codex` CLIs, authenticated with a
subscription login, not a metered API key** — this bills against the
flat-rate subscription instead of per-token API usage. A plain API key
stays available as an advanced/fallback option. See section 7 for why this
isn't the direct-API SDK approach an earlier version of this doc described.

Entirely admin-only: every route under `/api/blog-ai` requires
`authenticate` + `authorizeAdmin` (it manages API keys and triggers
billable AI calls — there is no public read side, unlike `/blog`).

## How it works

1. **Research** — Claude (or OpenAI) searches the live web for a trending,
   high-search-intent topic within the admin's configured subject areas,
   avoiding anything covered in recent posts.
2. **Write** — the assigned topic is handed to the writer, which returns
   structured JSON (title, primary keyword, content, tags, SEO fields)
   following the admin's style rules and the content-quality rules in
   section 3 below (one H1, keyword placement, link policy, etc.).
3. **Sanitize + guard** — deterministic passes strip em dashes, cap
   internal links, remove any link to a competitor domain, and downgrade a
   stray `<h1>` — regardless of whether the model obeyed the prompt.
4. **Cover image** — OpenAI generates a card-sized cover thumbnail, uploaded to a
   dedicated Supabase Storage bucket (`blog-covers`) — every other image
   upload in this app keeps using Cloudinary, untouched.
5. **Draft, not published** — the result is saved to `blog_ai_drafts`
   with `status = pending_review` and a countdown (`review_window_minutes`).
6. **Review window** — the admin can approve (publishes immediately) or
   reject (discards it) from the dashboard.
7. **Timeout → AI-checker** — if nobody responds in time, a cron sweep
   hands the draft to the *other* AI provider for an independent
   pass/fail review. Pass → published automatically. Fail → held back as
   `checker_failed` and the admin is emailed.
8. **Alerts** — a failed run, a checker rejection, or a "no working
   provider at all" outage all email the admin (SMTP).

Only a draft that is approved or passes the checker ever creates a real
`blog_posts` row — through the *same* `blogService.create()`
(`src/modules/blog/blog.service.ts`) the manual admin editor uses, so
slug-uniqueness and `published_at` stamping aren't duplicated.

---

## 1. One-time setup

### Environment variables

```
# Required
TOKEN_ENCRYPTION_KEY=<64 hex chars>

# Optional — admin alert emails. The app boots and runs fine without these;
# sendAdminAlert() just logs a warning and no-ops until they're set.
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="GHL Prime Auto Blog <noreply@ghlprime.com>"
ADMIN_ALERT_EMAILS=admin@ghlprime.com

# Optional — see "Optional extra: the public trigger endpoint" in section 4.
# Left unset (the default), /blog-ai/cron/trigger always rejects; the
# in-process scheduler poller runs regardless, with or without this set.
BLOG_AI_CRON_SECRET=
```

Generate `TOKEN_ENCRYPTION_KEY` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Database migration

Run once in the Supabase SQL editor (see `docs/SUPABASE.md` — this API
does not migrate anything at runtime). **If you already have the v1
tables** (`blog_ai_settings`, `blog_ai_accounts`, `blog_ai_runs`), only run
the `alter table` / `create table` statements below — everything is
additive.

```sql
create extension if not exists pgcrypto;

-- v1 tables (skip if they already exist)
create table if not exists blog_ai_settings (
  id boolean primary key default true,
  instructions text not null default '',
  keywords text not null default '',
  advanced_instructions text not null default '',
  categories text[] not null default array[
    'GoHighLevel', 'Automation', 'AI Agents', 'Case Studies', 'Voice AI', 'CRM', 'Vibe Coding'
  ],
  auto_blog_enabled boolean not null default true,
  schedule_hour integer not null default 10 check (schedule_hour between 0 and 23),
  schedule_minute smallint not null default 0 check (schedule_minute between 0 and 59),
  posts_per_day integer not null default 1 check (posts_per_day between 1 and 10),
  primary_provider text not null default 'anthropic' check (primary_provider in ('anthropic', 'openai')),
  fallback_enabled boolean not null default false,
  anthropic_model text not null default '',
  openai_model text not null default '',
  updated_at timestamptz not null default now(),
  constraint blog_ai_settings_singleton check (id = true)
);

create table if not exists blog_ai_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('anthropic', 'openai')),
  label text not null,
  token text not null,          -- AES-256-GCM ciphertext, never returned raw by the API
  token_preview text not null,  -- last 4 chars of the raw key, captured before encryption
  model text,
  enabled boolean not null default true,
  status text not null default 'idle',
  cooldown_until timestamptz,
  done_count integer not null default 0,
  failed_count integer not null default 0,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists blog_ai_accounts_provider_idx on blog_ai_accounts (provider);

create table if not exists blog_ai_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'success', 'failed')),
  provider text,
  account_label text,
  blog_post_id uuid references blog_posts(id) on delete set null,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists blog_ai_runs_started_at_idx on blog_ai_runs (started_at desc);

-- v2 additions: review workflow, style rules, research, images, alerting
alter table blog_ai_settings drop column if exists auto_publish; -- superseded by the review workflow below

alter table blog_ai_settings
  add column if not exists style_rules text not null
    default 'Do not use em dashes. Write short, clear sentences aimed at a general reader. Avoid jargon. Prefer active voice.',
  add column if not exists topic_focus_areas text[] not null
    default array['AI automation', 'CRM', 'GoHighLevel', 'Web Development'],
  add column if not exists review_window_minutes integer not null default 20
    check (review_window_minutes between 1 and 1440),
  add column if not exists image_generation_enabled boolean not null default true,
  add column if not exists web_search_enabled boolean not null default true,
  add column if not exists min_seo_score integer not null default 70
    check (min_seo_score between 0 and 100);

alter table blog_ai_runs add column if not exists alerted_at timestamptz;

create table if not exists blog_ai_drafts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references blog_ai_runs(id) on delete set null,
  provider text not null check (provider in ('anthropic', 'openai')),
  title text not null,
  slug text not null,
  category text not null,
  tags text[] not null default array[]::text[],
  excerpt text not null default '',
  content text not null,
  seo_title text not null default '',
  seo_description text not null default '',
  seo_keywords text not null default '',
  reading_time integer,
  cover_image text,
  cover_image_alt text,
  topic_research jsonb,        -- what the research step found + why this topic was picked
  status text not null default 'pending_review'
    check (status in ('pending_review', 'checking', 'checker_failed', 'approved', 'rejected', 'published')),
  review_deadline timestamptz not null,
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  checker_result jsonb,        -- { pass, seo_score, issues[] }
  blog_post_id uuid references blog_posts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists blog_ai_drafts_status_idx on blog_ai_drafts (status);
create index if not exists blog_ai_drafts_review_deadline_idx on blog_ai_drafts (review_deadline);

-- Storage bucket for AI-generated cover images ONLY. Every other upload in
-- this app keeps going through Cloudinary — this bucket is not a general
-- media library.
insert into storage.buckets (id, name, public)
values ('blog-covers', 'blog-covers', true)
on conflict (id) do nothing;

-- v2.1: content-quality rules (keyword/link/heading policy) — run this
-- block too if you already ran everything above.
alter table blog_ai_settings
  add column if not exists competitor_domains text[] not null default array[]::text[],
  add column if not exists max_internal_links integer not null default 3
    check (max_internal_links between 0 and 10),
  add column if not exists blog_url_path text not null default '/blog';

alter table blog_ai_drafts add column if not exists primary_keyword text;

-- Live progress for the dashboard's Run Now button: the engine writes the
-- phase it's in here (researching / writing / reviewing_content /
-- generating_image / saving_draft) and clears it when the run ends.
alter table blog_ai_runs add column if not exists current_step text;

-- v3: CLI/subscription-based accounts (avoids per-token API billing)
alter table blog_ai_accounts add column if not exists auth_type text not null default 'oauth' check (auth_type in ('oauth', 'api_key'));

alter table blog_ai_settings
  add column if not exists claude_cli_command text,
  add column if not exists codex_cli_command text,
  add column if not exists codex_enabled boolean not null default false,
  add column if not exists placeholder_cover_image_url text not null default '';
```

> **Note on `cover_image_alt` and `primary_keyword`**: `blog_posts` has no
> columns for either, so neither is carried through when a draft is
> published — they stay visible on the draft record for admin/audit
> reference only. Adding them to the public blog would need its own schema
> change to `blog_posts`, out of scope here since that table is otherwise
> untouched.

If you've already run the RLS lockdown script from `docs/SUPABASE.md`,
re-run it (or explicitly `revoke`/`enable row level security` on the new
tables) — the API itself is unaffected either way, since it always uses
the service-role key.

### The CLIs (already installed — nothing extra to do)

`@anthropic-ai/claude-code` and `@openai/codex` are real entries in this
project's `package.json` `dependencies` — a plain `npm install` (which
Railway, or any host, already runs to deploy this app) installs both
automatically, with no separate global install step and no second service
to deploy. `env.ts`'s `CLAUDE_CLI_PATH`/`CODEX_CLI_PATH` default to the
binaries that lands in this project's own `node_modules/.bin`.

If you ever want to point at a different install instead (a global one, or
a specific version pinned outside `package.json`), override it per-install
via the `claude_cli_command` / `codex_cli_command` settings fields — set to
an absolute path, and that wins over the bundled default.

### Connect a Claude account (recommended — avoids API billing)

From the AI Connections page, click **Connect in browser** → this starts
`claude setup-token` in a server-side pty, shows you the `claude.com`
authorize URL, and once you approve it and paste the code back, the
resulting subscription token is captured and encrypted automatically.
Behind the scenes: `POST /accounts/connect/claude/start` → poll `GET
/accounts/connect/claude/:sessionId` → `POST
/accounts/connect/claude/:sessionId/code`.

**Advanced/fallback**: paste a real Anthropic API key instead via
`POST /api/blog-ai/accounts` with `{ "label": "...", "apiKey": "sk-ant-api...", "authType": "api_key" }`
— this is metered per-token, used only if you specifically want it as a
backup path. Never paste a `claude setup-token` output here directly; use
the browser-connect flow for that.

### Connect Codex/ChatGPT (optional fallback + cover images need a separate key)

Codex has no per-account rotation — it's a single ambient login for the
whole server. Turn it on with `codexEnabled: true` in settings, then either
click **Connect in browser** on the Codex panel (`POST /codex/connect/start`
→ poll `GET /codex/connect/:sessionId` — no code to paste back, it approves
itself once you authorize in your browser) or run `codex login --device-auth`
directly in a shell on the deployed instance (Railway's dashboard has a
built-in **Shell** tab for exactly this, or use the `railway shell` CLI
command — no SSH setup needed). Check it any time with `GET /codex/status`,
disconnect with `POST /codex/disconnect`.

**Cover images always need a real OpenAI API key** — neither the Codex
ambient login nor any Claude account can generate images; add one via
`POST /api/blog-ai/accounts` with `{ "provider": "openai", "apiKey": "sk-...", "authType": "api_key" }`.
Without one, posts fall back to `placeholderCoverImageUrl` (set this in
settings — it ships empty).

---

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/blog-ai/settings` | Read current settings (defaults if never saved) |
| PUT | `/api/blog-ai/settings` | Update settings — partial body, merges onto the existing row |
| GET | `/api/blog-ai/accounts` | List provider accounts (no keys) |
| POST | `/api/blog-ai/accounts` | Add an account (`label`, `provider`, `apiKey`, optional `model`) |
| PUT | `/api/blog-ai/accounts/:id` | Update `label` / `model` / `enabled` |
| DELETE | `/api/blog-ai/accounts/:id` | Remove an account |
| POST | `/api/blog-ai/accounts/:id/test` | Send a trivial "reply OK" ping to confirm the account works |
| POST | `/api/blog-ai/accounts/test-all` | Test every enabled account concurrently |
| POST | `/api/blog-ai/accounts/connect/claude/start` | Start the browser-based Claude OAuth connect flow |
| GET | `/api/blog-ai/accounts/connect/claude/:sessionId` | Poll connect session status (url/code/result) |
| POST | `/api/blog-ai/accounts/connect/claude/:sessionId/code` | Submit the OAuth code back |
| DELETE | `/api/blog-ai/accounts/connect/claude/:sessionId` | Cancel a connect attempt |
| POST | `/api/blog-ai/codex/test` | Ping the ambient Codex login |
| POST | `/api/blog-ai/codex/connect/start` | Start the Codex device-auth connect flow |
| GET | `/api/blog-ai/codex/connect/:sessionId` | Poll connect session status |
| DELETE | `/api/blog-ai/codex/connect/:sessionId` | Cancel a connect attempt |
| GET | `/api/blog-ai/codex/status` | Check whether the ambient Codex login is currently valid |
| POST | `/api/blog-ai/codex/disconnect` | Log out the ambient Codex session |
| POST | `/api/blog-ai/run-now` | Trigger a generation run immediately, bypassing the schedule gate |
| GET | `/api/blog-ai/runs?limit=50` | Run history, newest first |
| GET | `/api/blog-ai/drafts?status=pending_review` | List drafts (status filter optional) |
| GET | `/api/blog-ai/drafts/:id` | Full draft detail, including `topic_research` and `checker_result` |
| POST | `/api/blog-ai/drafts/:id/approve` | Publish the draft now |
| POST | `/api/blog-ai/drafts/:id/reject` | Discard the draft — never published |

### Settings fields

`instructions`, `keywords`, `advancedInstructions`, `styleRules` — free
text fed into the writing prompt (`styleRules` is also fed into the
AI-checker's rubric). `categories` — the allowed category list, enforced
on the AI's JSON output. `topicFocusAreas` — subject areas the research
step searches within. `reviewWindowMinutes` (1–1440) — how long an admin
has to approve/reject before the checker takes over. `minSeoScore`
(0–100) — the checker's pass bar. `imageGenerationEnabled` /
`webSearchEnabled` — feature toggles. `scheduleHour` (0–23 UTC) /
`postsPerDay` (1–10) — used by the cron gate, not by `run-now`.
`primaryProvider` / `fallbackEnabled` — which provider writes first and
whether to fall back. `anthropicModel` / `openaiModel` — default models
when an account doesn't specify its own. `competitorDomains` — domains that
must never appear as an outbound link (fill this in — it defaults to
empty). `maxInternalLinks` (0–10, default 3) — cap on own-site links per
post. `blogUrlPath` (default `/blog`) — used to build internal link
candidates as `${SITE_URL}${blogUrlPath}/<slug>`; change it if the live
site's blog route differs. `claudeCliCommand` / `codexCliCommand` — override
the `claude`/`codex` binary path when it isn't on `PATH`. `codexEnabled` —
turns on the ambient Codex fallback (off by default). `placeholderCoverImageUrl`
— used for a post's cover when no OpenAI API key account is configured.

---

## 3. Content quality rules

Every rule below is fed into both the writing prompt and the AI-checker's
rubric — but the ones marked **hard-enforced** are backed by deterministic
code in `blogAi.linkGuard.ts` and `blogAi.styleGuard`-style sanitizers, so
a post can't slip through just because the model ignored an instruction.

| Rule | How it's enforced |
|---|---|
| No em dashes anywhere | Prompted, then **hard-enforced** — `textSanitize.ts` strips them from every text field regardless |
| No harmful/dangerous/abusive/inappropriate content | Prompted + checker hard-fail condition |
| One primary focus keyword, used naturally (not stuffed) in title, slug, SEO title, SEO description, opening paragraph, and a heading | Prompted (required `primary_keyword` field) + checker hard-fail if missing from title/SEO title |
| Compelling, keyword-focused titles for CTR, never misleading clickbait | Prompted + checker hard-fail on a title/content mismatch |
| Only one H1 per page (the post title) — body content starts at H2, nests logically | Prompted, then **hard-enforced** — any stray `<h1>` in the generated content is automatically downgraded to `<h2>` |
| Up to `maxInternalLinks` internal links, only from real published posts | Prompted (a real candidate list is given, model can't invent URLs) + **hard-enforced** — `blogAi.linkGuard.ts` unwraps any internal link beyond the cap |
| External links allowed for citations, but never to a `competitorDomains` entry | Prompted + **hard-enforced** — `blogAi.linkGuard.ts` unwraps (never blocks the whole post over) any link matching a configured competitor domain |
| Click-worthy, professional cover thumbnail, card-sized (not a full-page hero) | Image prompt (`blogAi.images.ts`) explicitly asks for a small-card composition at a 3:2 ratio (1200×800) |
| Readable: short paragraphs, clear headings, useful formatting, genuine usefulness | Prompted + checker rubric |

**Fill in `competitorDomains` before relying on this** — it ships empty.
Until you add your real competitors' domains via `PUT /settings`, the model
is only relying on its own judgment ("avoid obvious direct competitors") to
avoid linking to them.

---

## 4. Scheduling

`blogAi.scheduler.ts`'s `runDueBlogAiTasks()` is the single, stateless "is a
post due right now" check — safe to call as often as you like.

- **Daily generation** is due once `schedule_hour:schedule_minute` UTC has
  passed today (both admin-editable from the Auto Blog page — takes effect
  on the very next check, no restart or re-arming needed, since settings are
  read fresh every time). Gated on `auto_blog_enabled`; skipped entirely
  when off. On failure it's retried by the NEXT check that comes in — at
  least once, never more than 3 failed attempts since today's scheduled
  moment — before giving up for the day and relying on the existing
  failure-alert email. Every attempt forces `billingSafeOnly: true`: an
  unattended scheduled run can only use a connected Claude/Codex
  subscription login, never a metered API-key account, even if one is
  configured as a manual-run fallback.
- **Review-window sweep** runs on every single check, unconditionally,
  independent of `auto_blog_enabled` — a draft already awaiting review still
  needs its timeout handled on a day nothing new generates.

`POST /run-now` remains a separate, ungated manual trigger for
testing/on-demand use, unaffected by `auto_blog_enabled` — it does not run
the sweep itself and may use a metered API-key account if one is configured.

### Primary mechanism: the in-process poller (Railway, or any persistent host)

`server.ts`'s `bootstrap()` calls `initBlogAiScheduler()`, which arms an
in-process `node-cron` poll every 5 minutes calling `runDueBlogAiTasks()`
directly. This is the whole story on Railway (or any host that runs
`npm start` as a long-lived process) — nothing else to configure, no
external scheduler, no second service.

If you'd rather use OS-level crontab instead (e.g. running the API as
multiple replicas, where only one process's in-process poller should really
fire), `scripts/runBlogAi.ts` still works standalone — don't run both
against the same database, pick one:

```
*/5 * * * * cd /path/to/backend && npm run blog-ai:cron >> /var/log/blog-ai.log 2>&1
```

### Optional extra: the public trigger endpoint

`POST /blog-ai/cron/trigger` is a **public** route (registered before the
admin-JWT gate in `blogAi.routes.ts`) that calls `runDueBlogAiTasks()` once
per hit, guarded by `BLOG_AI_CRON_SECRET` (`requireCronSecret` in
`blogAi.controller.ts`) and a dedicated rate limit (`cronTriggerLimiter`).
It exists as a manual-test/backup mechanism — e.g. hit it by hand to force
an immediate due-check without waiting up to 5 minutes for the poller, or
point an uptime monitor at it as a second signal. Leave `BLOG_AI_CRON_SECRET`
unset (the default) and this route just always rejects; it has no effect on
the in-process poller either way, which runs regardless.

---

## 5. Deploying to Railway (all-in-one, no second service)

`claude`/`codex`'s platform binaries are roughly 210MB and 380MB
respectively. That's far past what a **Vercel serverless function** can
bundle (~250MB unzipped limit) — this feature previously needed a separate
always-on worker process for exactly that reason. **Railway runs a normal
persistent container instead**, with no such size ceiling, so that split is
unnecessary there: everything (dashboard, API, the in-process scheduler,
and the CLI calls themselves) runs as one deployed service.

1. Create a Railway service pointed at this repo. If your repo also
   contains the frontend as a sibling folder, set the service's **Root
   Directory** to `GHL-Prime-Backend` so Railway builds/runs this project
   specifically.
2. Railway auto-detects the `build` and `start` scripts in `package.json`
   (Nixpacks) — no extra config needed. `npm install` during the build
   already installs `@anthropic-ai/claude-code` and `@openai/codex` as
   regular dependencies (see "The CLIs" above); nothing to install
   separately.
3. Set the required environment variables in Railway's dashboard —
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_ACCESS_SECRET`,
   `JWT_REFRESH_SECRET`, `TOKEN_ENCRYPTION_KEY` at minimum (see
   "Environment variables" above for the full list).
4. Deploy. Once it's live, connect a Claude account from the AI Connections
   page exactly as described above (paste a token, or "Connect in
   browser" — both work normally here since this is a real persistent
   process, not a serverless function: in-memory connect sessions and
   `node-pty` both behave exactly like they would on a VPS).
5. If you want Codex too, either use its "Connect in browser" button or run
   `codex login --device-auth` from Railway's **Shell** tab (or
   `railway shell` via the CLI) — this needs to happen on the deployed
   instance specifically, since Codex's login is ambient/host-bound rather
   than a portable token like Claude's.

That's the whole deployment — no VPS, no separate worker, no external cron
service required. The scheduler runs itself (section 4).

---

## 6. Email alerts — what they cover, and what they don't

Alerts fire while the Node process is running, for:
- A generation run failing (debounced — at most one email per 30 minutes
  per kind of failure, via `blog_ai_runs.alerted_at`).
- No working AI account at all on either provider (critical outage).
- A draft failing its AI-checker review (needs manual attention).

**They cannot cover the server itself going offline** — nothing running
inside a dead process can send an email about it. Pair this with a free
external uptime monitor (e.g. [UptimeRobot](https://uptimerobot.com) or
Better Stack) hitting `GET /api/health` every few minutes, configured to
alert the same admin address. That's the only way to catch true downtime;
it's a one-time account setup outside this codebase.

---

## 7. Why the CLI/subscription approach (and its real risks)

An earlier version of this feature called the Anthropic/OpenAI APIs
directly (`@anthropic-ai/sdk`, `openai`), which is simpler and needs no
native dependencies — but bills per token, which adds up fast at
auto-blogging volume. Shelling out to the `claude`/`codex` CLIs
authenticated with a subscription login bills at the subscription's flat
rate instead, on whatever persistent host actually runs them (Railway, or a
VPS). That's the whole reason for this design — it isn't free of tradeoffs,
so know what you're accepting:

- **The CLI binaries are large (~210MB/~380MB) and need a persistent host**
  — this is exactly why they're bundled as real `dependencies` rather than
  something Vercel could ever run: a serverless function has a hard ~250MB
  unzipped size limit that either binary alone exceeds. Railway (and a
  plain VPS) run a normal container/process with no such ceiling, so
  bundling them there is fine. If no CLI account is connected at all,
  `resolveProviderRuntime()` correctly reports no provider available rather
  than silently failing.
- **`node-pty` needs native compilation** at `npm install` time — the host
  needs build tools (`python3`, `make`, a C++ compiler); Railway's Nixpacks
  builder already has these. A build environment that skips it (or blocks
  its install script — `allowScripts` in `package.json` already approves it
  for this sandbox's own local dev checks, though real `npm install`
  elsewhere doesn't gate on that at all) means the connect-from-browser flow
  fails at runtime with a clear "not available in this environment" message
  instead of crashing the app (see `blogAi.ptyRunner.ts`'s lazy import), and
  "paste a token" still works as the fallback either way.
- **A cancelled/failed browser-connect attempt can, if the credential-file
  backup/restore in `blogAi.ptyRunner.ts` is ever bypassed, wipe out a
  previously-working ambient login** — this was observed against the real
  Codex CLI during this feature's original development. That backup/restore
  logic is load-bearing, not optional hardening.
- **Claude cannot generate images under any plan** — the `placeholderCoverImageUrl`
  fallback exists specifically because of this; it isn't a bug to work around.
- A plain API key (`authType: "api_key"`) is still fully supported per
  account, still goes through the CLI (just a different env var), and is
  the only path if you'd rather not deal with the pty/OAuth flow at all —
  metered billing, in exchange for less operational complexity.
