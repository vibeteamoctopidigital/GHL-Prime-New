# Blog Writer — AI blog publishing

Replaces the old Auto Blog / `blog-ai` feature (Supabase Storage,
API-key-based providers, an in-process scheduler built for Vercel's lack of
a persistent process). This version:

- Is Postgres/Prisma end to end — no Supabase anywhere.
- Runs on your **Claude Code subscription**, never a metered API key. No
  `ANTHROPIC_API_KEY` anywhere in this feature.
- Is one long-running watcher process (`npm run blog:watch`), not a
  cron-triggered HTTP endpoint.

The `BlogAiSettings`/`BlogAiAccount`/`BlogAiRun`/`BlogAiDraft` tables from
the old feature still exist in the database, untouched — dropping them is a
separate, deliberate step (dump the data, confirm, then drop), not part of
this change.

## How it fits together

- **Admin screens** (`/admin/blog-writer`, `/admin/blog-schedules`) call
  `/api/blog-writer/*` — plain REST, admin-JWT gated like every other
  mutation in this app. The browser only ever inserts a `pending` row or
  reads history; it never spawns anything.
- **The watcher** (`scripts/blog-watch.ts`, run via `npm run blog:watch`) is
  the only process that spawns `claude`. It polls for due work with a
  single-flight `SELECT ... FOR UPDATE SKIP LOCKED` claim, so it's safe even
  if a restart briefly overlaps two instances — Postgres won't let both
  claim the same row.
- **The spawned `claude -p` session** follows `.claude/commands/write-blog.md`
  step by step, calling `scripts/blog-queue.ts`, `scripts/blog-audit.ts`,
  and `scripts/blog-import.ts` (via its Bash tool access) to read/write
  Postgres, audit its own draft, and source a cover image. Every phase
  update the admin UI's phase list shows comes from these tool calls in
  real time — not a timer.

```
admin screen --REST--> Express API --insert 'pending'--> blog_write_requests
                                                                |
                                                    blog-watch.ts polls,
                                                    claims (FOR UPDATE SKIP LOCKED)
                                                                |
                                                  spawns `claude -p` (subscription)
                                                                |
                                    write-blog.md: rules -> research -> write ->
                                    audit -> image -> save (all via blog-queue.ts)
                                                                |
                                                degrees blog_posts row
                                          (published, if auto-publish + audit pass;
                                                draft otherwise)
```

## 1. Prerequisites on the host

- Node.js and this repo already installed (`npm install`).
- `@anthropic-ai/claude-code` is already a project dependency (see
  `package.json`) — `npm install` alone puts a working `claude` binary at
  `node_modules/.bin/claude`. No separate global install needed on a fresh
  host, unlike the original Supabase-era doc this replaces.

## 2. Log in to Claude Code — do this on the real host, interactively

```bash
node_modules/.bin/claude auth login    # interactive: prints a URL + code
# on a truly headless box:
node_modules/.bin/claude setup-token
node_modules/.bin/claude auth status   # confirm it took
```

**Smoke-test unattended execution before anything else:**

```bash
node_modules/.bin/claude -p "Reply with exactly: OK"
```

You should get `OK` and exit code 0. **If this fails, stop here** — nothing
below will work until it passes. Run the watcher as the SAME OS user that
did this login; Claude Code's credentials live in that user's home
directory.

`blog-watch.ts` resolves the binary in this order: `CLAUDE_BIN` (explicit
override) → this project's own `node_modules/.bin/claude` → `~/.local/bin/claude`
→ bare `claude` on `PATH`.

## 3. Environment variables

Already-existing vars this feature reuses as-is: `DATABASE_URL`,
`CLOUDINARY_CLOUD_NAME`/`CLOUDINARY_API_KEY`/`CLOUDINARY_API_SECRET`/
`CLOUDINARY_UPLOAD_FOLDER`. New ones (all optional — see `.env.example`):

```env
PEXELS_API_KEY=            # stock photos for blog:import; without either
UNSPLASH_ACCESS_KEY=       # key, posts simply get no cover image
BLOG_WRITER_MODEL=sonnet
# CLAUDE_BIN=/path/to/claude   # only if the resolution order above doesn't find it
```

## 4. Apply the schema

**Not done yet in this session** — `DATABASE_URL` in `.env` failed
authentication when this was built, so the schema below is written and
`prisma validate`-clean but not pushed anywhere. Once you have a working
connection string:

```bash
npx prisma db push
```

This is purely additive: 5 new tables (`blog_topics`, `blog_write_requests`,
`blog_run_schedules`, `blog_deleted_schedules`, `blog_writer_settings`) and
7 new optional columns on `blog_posts` (`target_keyword`, `cta_variant`,
`sources`, `research_mode`, `source_url`, `source_name`, `topic_id`). No
existing table, column, or row is modified. Take a backup first regardless
(`pg_dump`) if this is ever pointed at real production data — this repo's
own standing rule, not new to this feature.

## 5. systemd service

`/etc/systemd/system/ghlprime-blog-writer.service` — named specifically to
avoid a collision with any other app's generic `blog-writer.service` on a
shared box:

```ini
[Unit]
Description=GHL Prime Blog Writer watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_APP_USER
WorkingDirectory=/path/to/GHL-Prime-Backend
ExecStart=/usr/bin/npm run blog:watch
Restart=always
RestartSec=15
# Claude Code reads its login from this user's home directory.
Environment=HOME=/home/YOUR_APP_USER
StandardOutput=append:/var/log/ghlprime-blog-writer.log
StandardError=append:/var/log/ghlprime-blog-writer.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo touch /var/log/ghlprime-blog-writer.log && sudo chown YOUR_APP_USER /var/log/ghlprime-blog-writer.log
sudo systemctl daemon-reload
sudo systemctl enable --now ghlprime-blog-writer
sudo systemctl status ghlprime-blog-writer
tail -f /var/log/ghlprime-blog-writer.log
```

Restart the service (`systemctl restart`) rather than stop-then-start — a
restart is handled like any other interruption (see the table below).

## 6. Verify end to end

1. `/admin/blog-writer` — the badge should read **Online** within ~30s
   (heartbeat every 15s, offline after 2 minutes with none).
2. Add a topic, or type something into "Write something right now."
3. The run's phase list advances as the writer actually calls tools —
   reading the standard → researching → writing → auditing → images →
   saving. Not a timer.
4. `tail -f /var/log/ghlprime-blog-writer.log` — expect `picked up request`
   within ~20s, then the phases, then `request ... done`.
5. `/admin/blog` — the post is at the top, published or draft depending on
   the audit result and the auto-publish setting.

## What happens when things go wrong

| Situation | What the watcher does |
|---|---|
| Claude usage limit hit | Parked **waiting** with a `retry_after` (the message's own reset time if parseable, else 15→30→60min backoff), resumes automatically. Up to `max_retries` (default 6) attempts. Shown as "Paused," not failed. |
| Run exceeds `run_timeout_minutes` (default 25) | Same: waiting + retry. |
| Nothing worth writing / the session errors out | Request **failed**, topic **skipped** with a reason, queue moves on. Retry from the screen re-queues it. |
| Watcher restarted mid-run | Whatever was left `running` is parked `waiting` on the next start, picked up on the next poll. |
| A batch ("write next post" repeatedly, or a schedule's `posts_per_run`) | One request at a time, chained without waiting a full poll between them. Stop finishes the current post, then the chain ends. |
| Schedule due while the machine was off | Fires if under 6 hours late, otherwise writes the day off. Never fires twice in a day. |

## Known, deliberate differences from a from-scratch design

- **Drafts have no separate table.** The old `blog_ai_drafts`
  propose-then-approve flow is gone — a Blog Writer draft is just a
  `blog_posts` row with `published: false`. The existing `/admin/blog` page
  already lists and can publish/unpublish these; no separate review screen
  was built.
- **The CLI scripts are TypeScript run via `tsx`** (`blog-queue.ts`,
  `blog-audit.ts`, `blog-import.ts`, `blog-rules.ts`, `blog-watch.ts`), not
  plain `.mjs`. This matches how every other script in this backend already
  works (`seed.ts`, `refresh-sitemap.ts`) and lets them share Prisma types
  and `src/config`/`src/shared` utilities directly.
- **Sitemap refresh is a direct in-process function call**
  (`sitemapService.refresh()` from `blog-queue.ts`'s `save` command), not an
  HTTP call to a token-gated endpoint — both live in the same backend
  process, so there's no network hop or token to manage for this.
- **Mounted at `/api/blog-writer`**, not `/api/admin/blog-writer` — matches
  how every other module in `src/routes/index.ts` is actually mounted here
  (admin-only access is enforced by middleware inside the router, not by an
  `/admin/` path prefix).

## Not yet verified against a real run

Everything above compiles, typechecks, and builds cleanly, but has not run
against a real `claude` CLI session end to end (blocked on the `DATABASE_URL`
credential issue at build time). Two things worth a specific look once you
can run it for real:

1. **The `--allowedTools` flag name** in `blog-watch.ts`'s `runClaudeSession()`
   — confirm it matches `claude --help` for your installed CLI version.
2. **`detectUsageLimit()`'s regex** in `blog-watch.ts` — written from the
   general shape a usage-limit message takes, not a captured real one. Worth
   logging one real hit's raw text and refining the pattern against it.
