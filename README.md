# GHL Prime — Backend API

Standalone backend for GHL Prime, built on **Node.js + Express + TypeScript + JWT +
Supabase PostgreSQL**, with **Cloudinary** for image uploads.

This replaces the previous split backend (a Mongo/Express `server/`, Vercel serverless
functions in `api/`, and direct Supabase access from the browser). All data access now
goes through this one API, and Supabase Auth + RLS are replaced by JWT and role
middleware.

---

## Quick start

```bash
cd backend
npm install
npm run db:seed     # creates the admin account
npm run dev         # http://localhost:4000/api
```

Health check: `GET http://localhost:4000/api/health`
Database check: `GET http://localhost:4000/api/health/db`

**Default admin** (from `.env`, change before deploying):
`admin@ghlprime.com` / `Admin@12345`

TypeScript runs directly via `tsx` in development; `npm run build` emits JavaScript to
`dist/` and `npm start` runs it.

> `db:seed` creates **only** the login account. It deliberately does not seed content —
> the live Supabase project already holds real data, and overwriting it from static
> files would destroy edits made in the admin panel.

---

## How data access works

There is **no ORM and no Postgres connection string**. The API talks to Supabase over
PostgREST using `@supabase/supabase-js` with the service-role key:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_…
```

The secret key bypasses RLS, which is correct here because authorisation lives in this
API's own JWT + role middleware and the key never leaves the server.

PostgREST returns **snake_case**, which is the same casing the API emits — so there is
no output transform. Input is converted on the way in, which is why every endpoint
accepts either casing.

### Two consequences worth knowing

PostgREST exposes no multi-statement transactions:

- **Reorder is atomic** — it reads the affected rows, merges the new positions, and
  writes them back as one upsert, which Postgres applies as a single statement.
- **Relation syncing is not** — replacing case-study credits or showcase placements is
  a delete followed by an insert. A failure between them leaves the parent with *none*
  rather than duplicates: visible and correctable, the safer direction.

---

## Project structure

Modular by feature. Each module owns its routes, controller, service and validators;
anything used by more than one module lives in `src/shared`.

```
backend/
├── tsconfig.json              # strict, incl. noUncheckedIndexedAccess
├── vercel.json                # serverless config
├── api/index.js               # Vercel entry (exports the Express app)
├── prisma/seed.ts             # creates the admin account
├── scripts/
│   ├── list-routes.ts         # dumps the live route table
│   ├── test-api.mjs           # exercises all 144 endpoints
│   └── refresh-sitemap.ts     # build-time sitemap generation
└── src/
    ├── server.ts              # bootstrap, listen, graceful shutdown
    ├── app.ts                 # express assembly (security, parsing, routes)
    ├── types/
    │   ├── common.ts          # shared domain types
    │   └── express.d.ts       # types req.user globally
    ├── config/
    │   ├── env.ts             # zod-validated environment, fails fast
    │   ├── supabase.ts        # Supabase client singleton
    │   ├── cloudinary.ts      # Cloudinary client (optional at boot)
    │   └── constants.ts       # HTTP codes, roles, enums, pagination
    ├── routes/index.ts        # the one place modules are mounted
    ├── modules/
    │   ├── auth/              # login, refresh, logout, users
    │   ├── dashboard/         # admin counts + recent activity
    │   ├── case-studies/
    │   ├── blog/
    │   ├── team/              # leaders + "Meet The Experts"
    │   ├── gallery/           # categories + images
    │   ├── meeting-gallery/
    │   ├── partner-logos/
    │   ├── technology-logos/
    │   ├── showcase/          # items + stats + placements
    │   ├── contact/           # contact form + lead inbox
    │   ├── service-surveys/   # /services/* survey forms + inbox
    │   ├── uploads/           # Cloudinary + media library
    │   ├── sitemap/
    │   └── health/
    └── shared/                # the reusable layer — see below
```

### The reusable layer (`src/shared`)

This is what keeps the modules small. Most resources need no bespoke code at all.

| Component | What it gives you |
|---|---|
| `services/BaseService` | `list / listPaginated / findById / findOne / create / update / remove / count / exists` over any table, plus ILIKE search. |
| `services/SortableService` | Adds `listPublic()`, `listAll()` and an atomic `reorder()` for every `sort_order` + `published` resource. |
| `services/LeadService` | Spam filtering, CRM webhook forwarding, status pipeline and an admin inbox — shared by the contact form and the service surveys. |
| `factories/createCrudRouter` | Builds a full REST router (public reads, guarded writes, reorder) from a service and two schemas. |
| `factories/createCrudController` | The seven standard handlers, individually overridable. |
| `factories/createLeadRouter` | Public `submit` + guarded inbox (list / stats / detail / status / delete). |
| `validators/defineResourceSchema` | Generates create/update schemas that accept **both** `image_url` and `imageUrl`. |
| `serializers/caseTransform` | camelCase → snake_case on the way in. |
| `middleware/*` | `authenticate`, `optionalAuthenticate`, `authorize`, `validate`, `errorHandler`, `notFound`, rate limiters, upload. |
| `utils/*` | `ApiError`, `asyncHandler`, `ApiResponse`, `logger`, slug, pagination, token, password, object helpers. |

A complete resource is often two short files:

```ts
// technologyLogo.service.ts
export const technologyLogoService = new SortableService({
  table: 'technology_logos',
  resourceName: 'Technology logo',
  searchableFields: ['name'],
})

// technologyLogo.routes.ts
const { createSchema, updateSchema } = defineResourceSchema({
  fields: { name: requiredString('Name'), imageUrl: requiredString('Image URL') },
  required: ['name', 'imageUrl'],
})

export default createCrudRouter({ service: technologyLogoService, createSchema, updateSchema })
```

---

## Response format

Every endpoint returns the same envelope.

```jsonc
// success
{ "success": true, "message": "Blog posts retrieved", "data": [...], "meta": { ... } }

// error
{ "success": false, "message": "Validation failed",
  "errors": [{ "field": "title", "message": "Title is required" }] }
```

`meta` appears only on paginated listings.

Field names on the wire are **snake_case** (`image_url`, `sort_order`, `published_at`,
`assigned_team_members`), exactly as the React app already reads them.

---

## Authentication

JWT access token (15 min) + rotating refresh token (30 days, stored hashed).

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@ghlprime.com","password":"Admin@12345"}'
```

Send the result as `Authorization: Bearer <access_token>`. The refresh token is also
set as an httpOnly cookie, so browser clients can call `POST /api/auth/refresh` with
no body.

**Roles:** `ADMIN` (everything, incl. user management), `EDITOR` (all content),
`VIEWER` (read-only).

Public reads stay public. Every write requires `ADMIN` or `EDITOR`. Reading drafts
requires a token — the replacement for the old
`"authenticated can read all blog posts"` RLS policy.

---

## API reference

**Full reference: [`docs/API.md`](docs/API.md)** — all 144 endpoints with their full
URLs, request and response fields, error codes, and the data model.

Deploying: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Vercel) ·
[`docs/SUPABASE.md`](docs/SUPABASE.md) (Supabase notes).

Base URL: **`/api`** — quick index:

| Module | Base route |
|---|---|
| Auth | `/api/auth` |
| Admin dashboard | `/api/dashboard` |
| Case studies | `/api/case-studies` |
| Blog | `/api/blog` |
| Team (leaders + experts) | `/api/team` |
| Gallery | `/api/gallery` |
| Meeting gallery | `/api/meeting-gallery` |
| Partner logos | `/api/partner-logos` |
| Technology logos | `/api/technology-logos` |
| Showcase | `/api/showcase` |
| Contact | `/api/contact` |
| Service surveys | `/api/service-surveys` |
| Image uploads | `/api/uploads` |
| Sitemap | `/api/sitemap` |
| Health | `/api/health` |

Sortable collections (`team/members`, `team/experts`, `gallery/categories`,
`gallery/images`, `meeting-gallery`, `partner-logos`, `technology-logos`,
`showcase/items`, `showcase/stats`) all share one shape:

| Method | Path | Access |
|---|---|---|
| GET | `/` | public (published, display order) |
| GET | `/admin` | auth (all rows) |
| PATCH | `/reorder` | auth |
| GET | `/:id` | public |
| POST · PUT/PATCH · DELETE | `/`, `/:id` | auth |

> **Changing the prefix.** `/api` comes from `API_PREFIX` and is applied in one place
> (`src/app.ts`). Setting `API_PREFIX=/api/v2` moves every route at once.

---

## Environment

See `.env.example`. Required: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`. `env.ts` validates everything at boot and
exits with a readable message if something is missing, rather than failing later at
request time.

Generate real secrets before deploying:

```bash
openssl rand -base64 48   # once per JWT secret
```

**Cloudinary is optional.** Without it the API boots normally and only `/api/uploads/*`
returns `503`. With `CLOUDINARY_UPLOAD_PRESET` set, uploads go through that unsigned
preset instead of a signed request — the path that works when an account denies API
keys the `create` action.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch-mode server (tsx) |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:seed` | Create the admin account (safe to re-run) |
| `npm run sitemap:refresh` | Rebuild `public/sitemap.xml` |
| `npm run routes` | Print every registered route, straight from the Express router |
| `npm run test:api` | Exercise all 144 endpoints against a running server and report coverage |

`test:api` derives its checklist from the router itself, so an endpoint added without a
test is reported as uncovered rather than silently skipped.

> The suite spends ~8 of the 10 allowed login attempts. Running it twice inside the
> 15-minute auth window trips the rate limiter; restart the server (limits are
> in-memory) before re-running.

---

## Migrating from the old frontend

The tables are unchanged, so existing rows keep working. What changed:

| Before | Now |
|---|---|
| `supabase.from('x').select()` in the browser | `GET /api/x` |
| `supabase.auth.signInWithPassword()` | `POST /api/auth/login` |
| RLS policies | `authenticate` + `authorize` middleware |
| `/api/contact-submit` (Vercel) | `POST /api/contact/submit` |
| `/api/refresh-sitemap` (Vercel) | `POST /api/sitemap/refresh` |
| `/api/gone` (Vercel) | `GET /free-scripts` → 410 |
| Survey form → webhook only | `POST /api/service-surveys/submit` (persisted) |

Response field names match what Supabase returned, so component code does not change —
only the transport inside `src/lib/*Api.js`.

> Your Supabase tables are still readable through Supabase's own PostgREST endpoint
> with the anon key. Lock that down **only after** the frontend stops reading Supabase
> directly, or the live site will break.
