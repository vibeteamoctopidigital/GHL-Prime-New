# Deploying to Vercel

The backend is configured for Vercel's Node serverless runtime. This guide covers
the deploy itself and the handful of behaviours that differ from a normal server.

---

## 1. How it runs on Vercel

Vercel does not run a long-lived process — it invokes a function per request.

| File | Role |
|---|---|
| `api/index.js` | Serverless entry. Creates the Express app and exports it as the handler. **No `app.listen()`.** |
| `src/server.ts` | The traditional server (`npm start`). Not used by Vercel. |
| `vercel.json` | Build command, function settings, and a catch-all rewrite. |
| `.vercelignore` | Keeps `.env` and other local files out of the upload. |

`vercel.json` rewrites **every** path to `/api`, so Express keeps doing its own
routing exactly as it does locally.

The entry imports from `dist/`, which `npm run vercel-build` produces. Vercel
therefore never compiles TypeScript itself — what runs in production is exactly
the output `tsc` was verified against locally.

---

## 2. Deploy

### Set the root directory

The repository root contains both `backend/` and `ghlprime-example/`. In the
Vercel project settings set **Root Directory = `backend`**, or deploy from inside
that folder:

```bash
cd backend
vercel            # preview
vercel --prod     # production
```

Framework preset: **Other**. Build command and install command come from
`vercel.json`; leave them blank in the dashboard.

### Add the environment variables

**Settings → Environment Variables.** Add to *Production* (and *Preview* if you
use preview deploys). Everything in section 3 marked **required** must be set —
the function exits at boot with a readable message if any are missing.

### Deploy and verify

```bash
curl https://<your-project>.vercel.app/api/health
curl https://<your-project>.vercel.app/api/health/db
```

`health/db` proves the database is reachable from Vercel's network, which is the
single most useful check after a first deploy.

---

## 3. Environment variables

### Required

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` — Dashboard → Project Settings → API |
| `SUPABASE_SECRET_KEY` | The service-role/secret key. Server-side only — it bypasses RLS. |
| `JWT_ACCESS_SECRET` | Generate a fresh one — do not reuse the dev value. |
| `JWT_REFRESH_SECRET` | As above, and different from the access secret. |
| `CORS_ORIGINS` | Comma-separated frontend origins, e.g. `https://ghlprime.com,https://www.ghlprime.com`. Without this the browser blocks every request. |

```bash
openssl rand -base64 48   # run twice, once per secret
```

### Recommended

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Hides error internals; enables `secure` cookies |
| `SITE_URL` | `https://ghlprime.com` | Used to build sitemap URLs |
| `SITEMAP_REFRESH_TOKEN` | random 32-byte hex | Otherwise `POST /sitemap/refresh` is open to anyone |
| `CONTACT_WEBHOOK_URL` | LeadConnector trigger | Contact form → CRM |
| `SURVEY_WEBHOOK_URL` | LeadConnector trigger | Service surveys → CRM |

### Cloudinary (image uploads)

| Variable | Notes |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | From Settings → API Keys |
| `CLOUDINARY_API_KEY` | Must allow the `create` action, or set an unsigned preset below |
| `CLOUDINARY_API_SECRET` | |
| `CLOUDINARY_UPLOAD_FOLDER` | Defaults `ghlprime` |
| `CLOUDINARY_UPLOAD_PRESET` | Unsigned preset name. Set this when the account denies signed uploads. |
| `MAX_UPLOAD_SIZE_MB` | Automatically clamped to 4 on Vercel — see §5 |

Alternatively set `CLOUDINARY_URL` alone
(`cloudinary://<key>:<secret>@<cloud>`).

Uploads are **optional**: without these the API boots normally, logs a warning,
and only `/uploads/*` returns `503`.

### API_PREFIX

Routes are served under `/api`. That value comes from the `API_PREFIX` environment
variable, so **anything set in Vercel → Settings → Environment Variables overrides
the code default**. A leftover `API_PREFIX=/api/v1` there will keep serving
`/api/v1` no matter what the repository says.

Either delete the variable or set it to `/api`, then redeploy.

Confirm which prefix a deployment is actually using — the root route reports it:

```bash
curl https://<your-project>.vercel.app/
# -> { "success": true, "message": "GHL Prime API is running", "data": { "docs": "/api" } }
```

If that says `/api/v1`, the environment variable is the cause; the code default
is `/api`.

### Do not set

`PORT` — Vercel assigns it. `SITEMAP_OUTPUT_DIR` — unused on serverless (§4).

---

## 4. The database

Nothing to run at deploy time. The schema already exists in Supabase and the API
reaches it over PostgREST — there is no migration step, no connection pool and no
build-time database work.

The only one-off is the admin account:

```bash
cd backend
npm run db:seed
```

Safe to re-run: it exits early if the account already exists.

> **Change the seeded admin password immediately** via
> `POST /api/auth/change-password`, or set `SEED_ADMIN_PASSWORD` to something
> strong before seeding.

### Connection reuse

`src/config/supabase.ts` caches the client on `globalThis`, so a warm invocation
reuses it rather than constructing a new one per request. PostgREST is stateless
HTTP, so there are no Postgres connections to exhaust — one of the practical
advantages of this setup on serverless.

---

## 5. What behaves differently on serverless

The code detects Vercel via the `VERCEL` environment variable and adapts. You do
not need to configure any of this — it is documented so the behaviour is not
surprising.

### The sitemap is generated live, not written to disk

The filesystem is read-only apart from `/tmp`, and a file written during one
invocation would not exist in the next anyway.

- `GET /sitemap.xml` and `GET /api/sitemap/xml` generate the XML per request.
- `POST /api/sitemap/refresh` returns the URL count with
  `"written": false, "mode": "dynamic"` instead of failing on a read-only write.
- The post-save background refresh is skipped, since work queued after a response
  is not guaranteed to run on serverless.

Point Google Search Console at `https://<your-domain>/sitemap.xml` — it is always
current, with no refresh step needed.

### Uploads are capped at 4 MB

Vercel rejects request bodies over ~4.5 MB **at the edge, before the function
runs**, so a larger configured limit could never be honoured and the caller would
get an opaque platform `413`.

`MAX_UPLOAD_SIZE_MB` is therefore clamped to 4 on Vercel, with a warning at boot.
`GET /uploads/status` reports the *enforced* number, so the admin UI shows the
truth.

**For larger files**, use the signed browser-direct flow, which skips this
function entirely and has no such limit:

1. `GET /api/uploads/signature?folder=ghlprime/team`
2. Upload straight to Cloudinary from the browser with that signature.

### Rate limits are per-instance

`express-rate-limit` uses an in-memory store, so each warm instance counts
separately and the effective limit is looser than configured. Fine as
brute-force friction; if you need exact global limits, back it with Redis
(`rate-limit-redis`) or use Vercel's WAF.

### Cold starts

The first request after idle pays module init plus the first PostgREST round trip —
typically under a second, since there is no connection pool to establish. Vercel's default 10 s function
timeout is comfortable; `vercel.json` sets 30 s anyway to leave headroom for an
upload on a cold start.

---

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Boot fails: `Invalid environment configuration` | A required variable is missing. The log names each one. |
| `Cannot reach Supabase` | Wrong `SUPABASE_URL` or `SUPABASE_SECRET_KEY`. |

| Every browser request fails with a CORS error | `CORS_ORIGINS` does not list your frontend origin. Include the scheme, no trailing slash. |
| `503 CLOUDINARY_NOT_CONFIGURED` | Cloudinary variables absent. The message names them. |
| `502 CLOUDINARY_FORBIDDEN` | Signed upload refused by the account. Create an unsigned upload preset and set `CLOUDINARY_UPLOAD_PRESET`. |
| `remote_deleted: false` on delete | The account withholds the `delete` action; the record is removed but the file stays in Cloudinary storage. |
| `413` on upload with no JSON body | File exceeded Vercel's ~4.5 MB body cap before reaching the function. Use the signature flow. |
| `401` on `POST /sitemap/refresh` | `SITEMAP_REFRESH_TOKEN` is set; send it as `Authorization: Bearer …` or `X-Sitemap-Token`. |
| `429` unexpectedly | Auth limiter is 10 requests / 15 min per IP. |

Logs: **Vercel dashboard → your project → Logs**, or `vercel logs <url>`.

---

## 7. Pre-flight checklist

Before the first production deploy:

- [ ] Root Directory set to `backend`
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` freshly generated, not the dev values
- [ ] `SUPABASE_URL` and `SUPABASE_SECRET_KEY` set
- [ ] `CORS_ORIGINS` lists the real frontend origin(s)
- [ ] `NODE_ENV=production`
- [ ] Admin account created (`npm run db:seed`)
- [ ] Seeded admin password changed
- [ ] `SITEMAP_REFRESH_TOKEN` set
- [ ] Cloudinary can upload — signed key with `create`, or `CLOUDINARY_UPLOAD_PRESET` set
- [ ] `curl https://<domain>/api/health/db` returns `200`

Locally, before pushing:

```bash
npm run typecheck   # must be clean
npm run build       # must succeed
npm run test:api    # 240 checks, 144/144 endpoints
```
