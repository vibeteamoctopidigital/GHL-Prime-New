# Blog Writer — VPS setup & Claude login

A complete, copy-pasteable guide to running the automatic AI blog writer on a
VPS: the API, the admin screens, the **watcher** that actually writes, and the
Claude subscription login the writer runs under.

This is the operator's guide. For the internal design (tables, phases, files),
see [BLOG_WRITER.md](BLOG_WRITER.md). The older
[blog-writer-setup.md](blog-writer-setup.md) covers the same ground for the
`ghlprime-updated` frontend repo; where they differ, use this one — the admin
screens now live in this repository's `frontend/`.

---

## What runs where

```
Browser  ──▶  Nginx  ──▶  Next.js frontend (this repo: frontend/)   ─┐
                    └──▶  Express API      (this repo: backend/)   ──┼─▶  Postgres
                                                                     │
                         blog-watch.ts  (systemd service)  ◀────────┘
                                │  claims a request, spawns
                                ▼
                         claude -p  (your Claude subscription)
                                │
                                ▼
                         blog_posts row  (draft unless auto-publish passes)
```

- The admin buttons only record a `pending` request in the database.
- The **watcher** (`npm run blog:watch`) is the only process that writes. It
  heartbeats every 15s and polls every 30s.
- Writing runs on a **Claude subscription** — no per-post API billing.

---

## 0. Prerequisites

- A VPS with **Node 22+** (`node -v`).
- **PostgreSQL** reachable (local, Railway, Neon, Supabase — any works).
- Outbound internet (research, Pexels, Cloudinary, the DB).
- `git`, and ideally `build-essential` + `python3` for native modules
  (`node-pty` powers the dashboard Claude login page):

```bash
sudo apt update
sudo apt install -y git build-essential python3
```

---

## 1. Get the code

```bash
sudo mkdir -p /srv/ghlprime && sudo chown "$USER" /srv/ghlprime
git clone <your-repo-url> /srv/ghlprime
cd /srv/ghlprime/backend
npm install            # NOT `npm ci --omit=dev` — the watcher needs dev deps
```

Keep the two apps side by side: `/srv/ghlprime/backend` and
`/srv/ghlprime/frontend`.

Decide on the **service user** now — the user that runs the watcher. Use the
same user everywhere below, including the Claude login (step 4). This guide
assumes it owns `/srv/ghlprime`.

---

## 2. Backend environment

Create `/srv/ghlprime/backend/.env`:

```env
NODE_ENV=production
PORT=4000

# --- Database -------------------------------------------------------------
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# --- Auth (generate two long random strings) ------------------------------
JWT_ACCESS_SECRET=replace-with-a-long-random-string-min-16-chars
JWT_REFRESH_SECRET=replace-with-another-long-random-string-min-16-chars

# --- CORS (your public site origin) ---------------------------------------
CORS_ORIGINS=https://yourdomain.com

# --- Site -----------------------------------------------------------------
SITE_URL=https://yourdomain.com
SITEMAP_REFRESH_TOKEN=some-long-random-token

# --- Seed admin (first run only) ------------------------------------------
SEED_ADMIN_EMAIL=admin@yourdomain.com
SEED_ADMIN_PASSWORD=ChangeMeNow_123

# --- Blog writer ----------------------------------------------------------
BLOG_WRITER_MODEL=sonnet     # writing model; the headline ranker always uses haiku
PEXELS_API_KEY=              # cover/body photos; blank = posts get no images
# UNSPLASH_ACCESS_KEY=       # optional second image source
# CLAUDE_BIN=               # only if the CLI is not found automatically

# --- Cloudinary (post images) ---------------------------------------------
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
# CLOUDINARY_UPLOAD_PRESET= # alternative: unsigned uploads
```

Generate secrets with `openssl rand -hex 32`.

> `DATABASE_URL` is the runtime connection string. `PEXELS_API_KEY` and the
> Cloudinary keys are optional for booting — without them posts are written
> with no images; without Cloudinary, image fetch is skipped.

---

## 3. Database schema + admin user

```bash
cd /srv/ghlprime/backend
npx prisma generate
npx prisma migrate deploy      # creates blog_topics, blog_write_requests, ...
npm run db:seed                # creates the admin login from SEED_ADMIN_*
```

Then confirm the queue tables are reachable:

```bash
npm run blog:queue             # prints defaults, queue, internal links
```

If that fails, the DB string is wrong — fix it before going further.

---

## 4. Install Claude Code and log in

Claude Code is what actually writes the posts. It ships as a dependency of this
repo, so it is already in `node_modules`, but install it globally too so you can
log in and test from any directory:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

The watcher resolves the binary in this order:

1. `CLAUDE_BIN` (if set in `.env`)
2. this repo's bundled copy — `backend/node_modules/.bin/claude`
3. `~/.local/bin/claude`
4. `claude` on `PATH`
5. the VS Code extension's bundled binary

**Log in as the same OS user that will run the watcher.** The credentials are
stored in that user's home directory; a login made as a different user is
invisible to the service.

### Option A — over SSH (most reliable)

```bash
claude setup-token
```

It prints a URL and waits. Open the URL in any browser, sign in with the
**Claude subscription** account, copy the code it shows, and paste it back into
the terminal. Then verify:

```bash
claude auth status
claude -p "Reply with exactly: OK"     # must print OK and exit 0
```

**If that last line does not print `OK`, stop here.** Nothing below works until
it does.

If `claude setup-token` tells you to export the token as
`CLAUDE_CODE_OAUTH_TOKEN`, put it in the systemd unit (step 6) as:

```ini
Environment=CLAUDE_CODE_OAUTH_TOKEN=the-token
```

### Option B — from the dashboard (no SSH)

The admin panel has **Claude Account** at `/admin/claude-auth`, which drives the
same login through a browser tab. It needs:

- the backend running as the **same user** as the watcher,
- `node-pty` working (the `build-essential`/`python3` install above, then
  `npm install` again).

Open `/admin/claude-auth` → **Connect account** → open the shown URL → sign in →
paste the code back → **Submit**. The page flips to *Connected*. Still confirm
over SSH with the two commands above.

> Switching accounts: **Log out** first on that page, then connect the new one.
> The watcher uses whichever login is stored for its user.

---

## 5. Run the watcher once, by hand

```bash
cd /srv/ghlprime/backend
npm run blog:watch
```

Expected:

```
blog writer watching
  claude:   /srv/ghlprime/backend/node_modules/.bin/claude
  model:    sonnet
  polling every 30s. Ctrl-C to stop.
  schedules: none set up
```

Leave it running, open `/admin/blog-writer` in a browser, and confirm the badge
reads **Writer online** (it can take up to ~30s). Then `Ctrl-C`.

---

## 6. Keep the watcher running (systemd)

Create `/etc/systemd/system/ghlprime-blog-writer.service`:

```ini
[Unit]
Description=GHL Prime AI blog writer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_APP_USER
WorkingDirectory=/srv/ghlprime/backend
ExecStart=/usr/bin/npm run blog:watch
Restart=always
RestartSec=15
Environment=HOME=/home/YOUR_APP_USER
StandardOutput=append:/var/log/ghlprime-blog-writer.log
StandardError=append:/var/log/ghlprime-blog-writer.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ghlprime-blog-writer
sudo systemctl status ghlprime-blog-writer
journalctl -u ghlprime-blog-writer -n 40 --no-pager
```

**One watcher per database.** Always `restart` rather than stop-then-start: on
start the watcher parks anything left `running` as `waiting` and picks it up.

---

## 7. Run the API

Create `/etc/systemd/system/ghlprime-api.service`:

```ini
[Unit]
Description=GHL Prime API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=YOUR_APP_USER
WorkingDirectory=/srv/ghlprime/backend
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/srv/ghlprime/backend/.env

[Install]
WantedBy=multi-user.target
```

Build and start:

```bash
cd /srv/ghlprime/backend
npm run build          # prisma generate + tsc
sudo systemctl daemon-reload
sudo systemctl enable --now ghlprime-api
sudo systemctl status ghlprime-api
curl -s http://127.0.0.1:4000/api/health
```

---

## 8. Build and serve the frontend

The admin screens read the API origin from `VITE_API_URL`, which
`frontend/next.config.js` inlines into the client bundle at **build time**. Set
it to your public origin so the browser calls `/api/*` on the same host that
Nginx forwards to the backend.

Create `/srv/ghlprime/frontend/.env` (or export before building):

```env
VITE_API_URL=https://yourdomain.com
```

```bash
cd /srv/ghlprime/frontend
npm install
npm run build          # content snapshot + sitemap + next build
```

Serve it with systemd, `/etc/systemd/system/ghlprime-web.service`:

```ini
[Unit]
Description=GHL Prime frontend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_APP_USER
WorkingDirectory=/srv/ghlprime/frontend
ExecStart=/usr/bin/npm run start -- -p 3000
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ghlprime-web
```

Rebuild the frontend whenever `VITE_API_URL` changes — the value is baked into
the bundle, not read at runtime.

---

## 9. Nginx (same origin for site + API)

```
server {
    listen 80;
    server_name yourdomain.com;

    # API — including the admin routes the dashboard calls.
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Everything else goes to the Next.js frontend.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then TLS with `sudo certbot --nginx -d yourdomain.com`.

Because the browser sees one origin, set `CORS_ORIGINS=https://yourdomain.com`
in the backend `.env` and you will not fight cross-origin issues.

---

## 10. Verify end to end

1. Open `https://yourdomain.com/admin/blog-writer` and log in with the seeded
   admin. The badge should read **Writer online**.
2. Type a topic in **Write something right now** and press **Add and write
   now**. (Or **Add to queue**, then **Write next post**.)
3. Watch the phase list advance as the session genuinely calls tools:
   Standard → Research → Writing → Audit → Images → Saving.
4. The run finishes in about **5 minutes**. Watch the log if you like:

   ```bash
   tail -f /var/log/ghlprime-blog-writer.log
   ```

   You will see `picked up request …`, the phases, a cost line, and
   `request … done`.
5. Open `/admin/blog` — the new post is at the top. It is a **draft** unless
   auto-publish is on **and** the audit and internal-link checks passed. Read
   it, then publish.

Turn on auto-publish in **Queue defaults** on the writer page if you want clean
posts to go live by themselves.

---

## 11. Schedules

On `/admin/blog-schedules`, create a daily run. Each schedule works in one of
two modes:

| Mode | What it writes |
|---|---|
| **From its keyword list** | The next keywords in that schedule's list, one post each. Consumed from the front, returned to the front if you press Stop. |
| **From saved sites** | Reads each enabled site, caps how much any one site contributes, and picks the day's best stories. |

Things to know:

- Schedules **only fire while the watcher runs** — that is why it belongs on the
  server.
- Each fires **at most once a day**. A run missed by **under 6 hours** still
  happens when the machine comes back; later than that, the day is written off.
- Posts are written **one at a time**, even when several are due.
- You can **import a Google Sheets content calendar** into the queue or into a
  schedule (share the sheet as “anyone with the link can view”).
- **Keep volumes sensible.** Every post counts against the subscription's usage
  window. One or two a day is a normal pace.

---

## 12. Troubleshooting

**Badge says "Writer offline"**

```bash
sudo systemctl status ghlprime-blog-writer
tail -50 /var/log/ghlprime-blog-writer.log
```

The writer is considered offline after 2 minutes with no heartbeat. Run
**only one** watcher per database.

**"Could not start Claude Code" / runs fail immediately**

The login almost certainly expired. Log in again (step 4), then:

```bash
claude auth status
claude -p "Reply with exactly: OK"
sudo systemctl restart ghlprime-blog-writer
```

**A post shows "Paused, will retry automatically"**

The Claude usage window is closed. The watcher waits (the message's own reset
time if it states one, otherwise 15 → 30 → 60 min backoff) and retries up to 6
times by itself. Nothing to do.

**A post is stuck / a run exceeded 25 minutes**

The run is stopped and retried automatically. A watcher restart mid-run parks
the request and picks it up on the next poll.

**Admin pages load but every action fails (404 / "Request failed (404)")**

The frontend was built with the wrong `VITE_API_URL`, or Nginx is not forwarding
`/api/`. Check:

```bash
curl -s https://yourdomain.com/api/health
```

and rebuild the frontend after fixing `VITE_API_URL`.

**Dashboard Claude login page says the PTY is unavailable**

`node-pty` did not build. `sudo apt install -y build-essential python3`, then
`cd /srv/ghlprime/backend && npm install`. Until then, log in over SSH.

**Posts have no cover image**

`PEXELS_API_KEY` (and/or `UNSPLASH_ACCESS_KEY`) is blank, or Cloudinary is not
configured. Set them and restart; no need to touch the watcher.

---

## 13. Security notes

- The spawned session runs under a **narrow tool allowlist** (read/write files,
  web search, and four of this project's own scripts). It cannot run arbitrary
  shell commands, use git, or delete anything. The worst a confused run can
  produce is a bad draft, which a person reviews.
- **Never** switch this to `--dangerously-skip-permissions`: that would give an
  unattended process full access to a server holding the database and Cloudinary
  credentials.
- Keep `.env` files out of git, and restrict `/etc/systemd/system/*.service`
  permissions so secrets in `Environment=` / `EnvironmentFile=` are not
  world-readable.

---

## Quick reference

| Thing | Command |
|---|---|
| Print the queue the writer sees | `npm run blog:queue` |
| Print the writing standard | `npm run blog:rules` |
| Run the watcher by hand | `npm run blog:watch` |
| Watcher service | `sudo systemctl restart ghlprime-blog-writer` |
| API service | `sudo systemctl restart ghlprime-api` |
| Watcher log | `tail -f /var/log/ghlprime-blog-writer.log` |
| Claude login check | `claude auth status && claude -p "Reply with exactly: OK"` |
