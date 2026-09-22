# AI Blog Writer + Scheduled Blogs

The same feature as octopi-web-new's AI Blog Writer, on this stack: Express +
Prisma/Postgres for the API and the watcher, Next.js (`ghlprime-updated`) for
the two admin screens. Posts are written by **Claude Code on a subscription**
— never a metered API key — in a session the watcher spawns on the machine
that runs it.

The retired Auto Blog tables (`blog_ai_*`) are left untouched; dropping them
is a separate, explicitly-confirmed step.

## How it fits together

- **Admin screens** — `/admin/blog-writer` (the queue, defaults, "Write next
  post" / "Write all", the run summary, recent runs, transfer-to-schedule) and
  `/admin/blog-schedules` (daily alarms, each with its own keyword backlog or
  its own list of news sites). They call `/api/blog-writer/*` and only ever
  record an ask; the browser cannot write anything.
- **The API** (`src/modules/blog-writer/`) — reads state, edits the queue and
  schedules, inserts a `pending` request. Admin-JWT gated.
- **The watcher** (`npm run blog:watch`, `scripts/blog-watch.ts`) — the one
  long-running process. Heartbeats every 15s, polls every 30s, fires due
  schedules, claims one request at a time (`FOR UPDATE SKIP LOCKED`), spawns
  `claude -p` under a tool allowlist, reads the run's stream-json events into
  the phase list the dashboard shows, and records the outcome and cost.
- **The spawned session** follows `.claude/commands/write-blog.md`: reads the
  writing standard (`npm run blog:rules`), reads the queue and the internal
  links it may use (`npm run blog:queue`), researches with WebSearch/WebFetch,
  writes `content/drafts/<slug>.json`, audits it (`npm run blog:audit`), and
  imports it (`npm run blog:import`) — which fetches Pexels images onto
  Cloudinary, checks every internal link resolves, decides draft vs.
  published, saves the `blog_posts` row, and marks the topic done.

```
admin screen --REST--> Express API --insert 'pending'--> blog_write_requests
                                                                |
                                       blog-watch.ts claims it, spawns `claude -p`
                                                                |
                write-blog.md: rules -> queue -> research -> write -> audit -> import
                                                                |
                                     blog_posts row (published only if auto-publish
                                     is on AND the audit is clean AND every internal
                                     link resolves; a draft otherwise)
```

A **batch** ("Write all", or a schedule's day) is a chain of single-post runs
sharing an id — the watcher queues the next topic when one finishes, until the
queue runs dry, the announced total is reached, or Stop clears the switch.
Stop never interrupts a post mid-write.

## Tables

| Table | What |
|---|---|
| `blog_topics` | The queue. `kind` is keyword / link / site; `status` queued / done / skipped; per-topic overrides for images, words, CTA (null = inherit). |
| `blog_write_requests` | One row per run: status, phase + steps timeline, failure kind, attempts/retry_after, batch id/total, usage (tokens, cost). |
| `blog_run_schedules` | Alarms: mode (`queue` / `sources`), time + IANA timezone, posts per day, images/words/CTA, `sites` JSON (with per-site `lastScan`), `last_run_day`. |
| `blog_schedule_keywords` | A schedule's keyword backlog, ordered by `position`; consumed from the front each morning. |
| `blog_deleted_schedules` | Snapshot of a deleted schedule, pruned after 7 days by the watcher. |
| `blog_writer_settings` | Key/value: queue defaults, auto-publish, active batch, summary cleared-at, writer heartbeat, pinned CTA. |

`blog_posts` gained `cover_image_alt`; its other writer columns
(`target_keyword`, `cta_variant`, `sources`, `research_mode`, `source_url`,
`source_name`, `topic_id`) were already there.

## 1. Prerequisites on the host

- Node 22+, this repo, `npm install`. `@anthropic-ai/claude-code` is a
  dependency, so `node_modules/.bin/claude` exists after install.
- Outbound internet (research, Pexels, Cloudinary, Postgres).

## 2. Log in to Claude Code — on the real host, as the user that runs the watcher

Either from the dashboard (`/admin/claude-auth`, which drives
`claude setup-token` for you) or by hand:

```bash
node_modules/.bin/claude setup-token   # headless: prints a URL + code
node_modules/.bin/claude auth status
node_modules/.bin/claude -p "Reply with exactly: OK"   # must print OK, exit 0
```

If that last line fails, stop — nothing below works until it passes.

`blog-watch.ts` resolves the binary as: `CLAUDE_BIN` → this project's bundled
copy (`claude.exe` on Windows, `.bin/claude` elsewhere) → `~/.local/bin/claude`
→ `PATH` → the VS Code extension's bundled binary.

## 3. Environment

Reuses `DATABASE_URL` and the `CLOUDINARY_*` vars. Optional additions:

```env
PEXELS_API_KEY=            # cover + body photos; without it posts get no images
BLOG_WRITER_MODEL=sonnet   # the writing session's model (the headline ranker always uses haiku)
# CLAUDE_BIN=/path/to/claude
```

## 4. Schema

Applied to the live database by `prisma/migrations/20260918150000_blog_writer_v2`.
On a fresh database: `npx prisma migrate deploy`.

## 5. Run the watcher

```bash
npm run blog:watch
```

It prints the binary it found, the model, and every schedule with its next
firing. Under systemd (`/etc/systemd/system/ghlprime-blog-writer.service`):

```ini
[Unit]
Description=GHL Prime AI blog writer watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_APP_USER
WorkingDirectory=/path/to/GHL-Prime-New
ExecStart=/usr/bin/npm run blog:watch
Restart=always
RestartSec=15
Environment=HOME=/home/YOUR_APP_USER
StandardOutput=append:/var/log/ghlprime-blog-writer.log
StandardError=append:/var/log/ghlprime-blog-writer.log

[Install]
WantedBy=multi-user.target
```

Same OS user as the Claude login. Restart rather than stop-then-start: on
start the watcher parks anything left `running` as `waiting` and picks it up.
**One watcher per database.**

## 6. Verify end to end

1. `/admin/blog-writer` shows **Writer online** within ~30s.
2. Add a topic and press **Write next post**. The card's phase list advances
   as the session actually calls tools: standard → research (N sources read)
   → writing (the draft filename) → audit (errors/warnings) → images → saving.
3. The log shows `picked up request …`, the phases, the cost line, and
   `request … done`.
4. `/admin/blog` lists the post at the top as a draft (or published, if
   auto-publish is on and the audit and link check passed). The run summary
   on the writer screen links to it.

## What happens when things go wrong

| Situation | What the watcher does |
|---|---|
| Claude usage limit hit | Request parked **waiting** with `retry_after` (the message's own reset time if it states one, else 15 → 30 → 60 min backoff). Shown as "Paused, will continue on its own". Up to 6 automatic retries. |
| Run exceeds 25 minutes | Same: waiting + retry. |
| Session says nothing worth writing / breaks on the topic | Request **failed**, topic **skipped** with the reason; the batch moves on. Retry from the screen re-queues both. |
| Session exits cleanly without saving a post | Failure kind `no-post`: failed + skipped, never silently re-picked (the bug the odl-32 fix closed). |
| Watcher restarted mid-run | The `running` row is parked `waiting` on the next start and picked up on the next poll. |
| Stop pressed during a batch | The current post finishes; nothing after it starts; a schedule's unwritten keywords go back to the FRONT of its list. |
| Schedule due while the machine was off | Fires if under 6 hours late, otherwise writes the day off. Never twice in a day. |
| A schedule's sites yield fewer stories than asked | Every enabled site is read; headlines are dealt fairly across sites (max 12 each) and ranked a page of 80 at a time until the day's count is met or the pool runs out. Each site's row shows what the last scan found / showed / picked. |

## Where things live

| Piece | Path |
|---|---|
| Pure rules shared by API, scripts (and mirrored in the dashboard) | `src/modules/blog-writer/lib/rules.ts`, `cta-variants.ts`, `run-schedule.ts` |
| Writing standard the session reads | `src/modules/blog-writer/lib/writing-standard.ts` (printed by `npm run blog:rules`) |
| Story picker criteria (sources schedules + site topics) | `src/modules/blog-writer/lib/story-picker-prompt.ts` |
| Audit | `src/modules/blog-writer/lib/audit.ts` |
| Headline discovery (feeds + scraping) | `src/modules/blog-writer/lib/headlines.ts` |
| Google Sheets calendar import | `src/modules/blog-writer/lib/sheet-import.ts` |
| Image placement, CTA slot | `src/modules/blog-writer/lib/image-placement.ts`, `stock-photo.ts` |
| Run event → phase tracker | `src/modules/blog-writer/lib/run-progress.ts` |
| Internal-link allow-list (static routes + services) | `src/modules/blog-writer/lib/site.ts` |
| DB helpers shared by API + scripts | `src/modules/blog-writer/blogWriter.store.ts` |
| API | `src/modules/blog-writer/blogWriter.{routes,service,validators}.ts` |
| Scripts | `scripts/blog-watch.ts`, `blog-queue.ts`, `blog-rules.ts`, `blog-audit.ts`, `blog-import.ts` |
| Workflow the spawned session follows | `.claude/commands/write-blog.md` |
| Drafts (git-ignored) | `content/drafts/*.json`, imported ones under `content/drafts/imported/` |
| Admin screens (ghlprime-updated) | `src/pages/AdminBlogWriterPage.jsx`, `AdminBlogSchedulePage.jsx`, `src/components/blogWriter/`, `src/lib/blogWriterApi.js`, `src/lib/blogWriterRules.js`, `src/styles/blog-writer.css` |
| Public post rendering of the CTA slot + sources | `ghlprime-updated/src/lib/blogContentSplit.js`, `src/pages/BlogPostPage.jsx` |

## Differences from octopi, on purpose

- Postgres/Prisma instead of Mongo: schedule keywords are their own table
  (paged and counted in SQL); everything else maps one to one.
- CTA banners are GHL Prime's copy variants (`general`, `automation`,
  `support`, `ai_agents`, `none`, plus `random`), picked from a dropdown; the
  site's `BlogCtaBanner` renders them at the slot the writer chose.
- Every post carries a `category` from the blog's fixed list; the writer picks
  it and the audit/importer enforce it.
- Sources are stored as JSON and rendered by the post page as a fold — no
  `<h2>Sources</h2>` trailer is appended to the body.
- Internal links resolve against a static route list plus `case_studies` and
  `blog_posts` (the frontend is a separate repo, so its routes cannot be read
  off disk).
- Deleted-schedule snapshots expire via the watcher's startup prune, not a
  TTL index.

## Verified / not yet verified

Verified on this branch: typecheck + lint on both repos; the schema migration
applied; every API flow (defaults, topics, bulk, reorder, overrides, apply,
schedules, keywords paging, sites validation, transfer, delete-returns-keywords,
request refused while offline) via a smoke script; the watcher heartbeating
and the dashboard showing it online; both admin screens rendering and
mutating through the real API; `claude -p` accepting the exact flags the
watcher uses.

Not yet run on this branch: a complete `pending → draft` post through the
watcher (to be done by hand — it spends subscription usage), a scheduled
`sources` scan against real feeds, and `blog:import` with `PEXELS_API_KEY`
set.
