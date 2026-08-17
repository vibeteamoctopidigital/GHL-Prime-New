# GHL Prime — Backend API

Standalone backend for GHL Prime, built on **Node.js + Express + TypeScript + JWT +
PostgreSQL + Prisma**.

This replaces the previous split backend (a Mongo/Express `server/`, Vercel serverless
functions in `api/`, and direct Supabase access from the browser). All data access now
goes through this one API, and Supabase Auth + RLS are replaced by JWT and role
middleware.

---

## Quick start

```bash
cd backend
npm install
npm run prisma:generate     # generate the Prisma client
npm run prisma:push         # create the tables in PostgreSQL
npm run db:seed             # seed content + the admin user
npm run dev                 # http://localhost:4000/api/v1
```

Health check: `GET http://localhost:4000/api/v1/health`

**Default admin** (from `.env`, change before deploying):
`admin@ghlprime.com` / `Admin@12345`

TypeScript runs directly via `tsx` in development; `npm run build` emits JavaScript to
`dist/` and `npm start` runs it.

---

## Project structure

Modular by feature. Each module owns its routes, controller, service and validators;
anything used by more than one module lives in `src/shared`.

```
backend/
├── tsconfig.json              # strict, incl. noUncheckedIndexedAccess
├── prisma/
│   ├── schema.prisma          # 19 models (17 tables + auth)
│   ├── seed.ts                # idempotent seed
│   ├── seed-data.ts           # static seed content
│   ├── importers.ts           # reusable row mappers + upserters
│   └── frontend-data.ts       # loads the React app's data modules
├── scripts/
│   ├── import-content.ts      # content import CLI
│   └── refresh-sitemap.ts     # build-time sitemap generation
└── src/
    ├── server.ts              # bootstrap, listen, graceful shutdown
    ├── app.ts                 # express assembly (security, parsing, routes)
    ├── types/
    │   ├── common.ts          # shared domain types
    │   └── express.d.ts       # types req.user globally
    ├── config/
    │   ├── env.ts             # zod-validated environment, fails fast
    │   ├── prisma.ts          # PrismaClient singleton
    │   └── constants.ts       # HTTP codes, roles, pagination defaults
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
    │   ├── sitemap/
    │   └── health/
    └── shared/                # the reusable layer — see below
```

### The reusable layer (`src/shared`)

This is what keeps the modules small. Most resources need no bespoke code at all.

| Component | What it gives you |
|---|---|
| `services/BaseService<TRow>` | `list / listPaginated / findById / findOne / create / update / remove / count / exists` over any Prisma model, plus search. |
| `services/SortableService<TRow>` | Adds `listPublic()`, `listAll()` and a transactional `reorder()` for every `sort_order` + `published` resource. |
| `services/LeadService<TRow>` | Spam filtering, CRM webhook forwarding, status pipeline and an admin inbox — shared by the contact form and the service surveys. |
| `factories/createCrudRouter` | Builds a full REST router (public reads, guarded writes, reorder) from a service and two schemas. |
| `factories/createCrudController` | The seven standard handlers, individually overridable. |
| `factories/createLeadRouter` | Public `submit` + guarded inbox (list / stats / detail / status / delete). |
| `validators/defineResourceSchema` | Generates create/update schemas that accept **both** `image_url` and `imageUrl`. |
| `serializers/caseTransform` | Deep camelCase ⇄ snake_case, so the API speaks the snake_case the frontend already reads. |
| `middleware/*` | `authenticate`, `optionalAuthenticate`, `authorize`, `validate`, `errorHandler`, `notFound`, rate limiters. |
| `utils/*` | `ApiError`, `asyncHandler`, `ApiResponse`, `logger`, slug, pagination, token, password, object helpers. |

A complete resource is often two short files:

```ts
// technologyLogo.service.ts
export const technologyLogoService = new SortableService<TechnologyLogo>({
  model: prisma.technologyLogo,
  resourceName: 'Technology logo',
  serialize: defaultSerializer,
})

// technologyLogo.routes.ts
const { createSchema, updateSchema } = defineResourceSchema({
  fields: { name: requiredString('Name'), imageUrl: requiredString('Image URL') },
  required: ['name', 'imageUrl'],
})

export default createCrudRouter({ service: technologyLogoService, createSchema, updateSchema })
```

The service classes are generic over their Prisma row type, so `serialize`, `create`
and `update` are all checked against the real model — a typo in a column name is a
compile error, not a runtime 500.

---

## Response format

Every endpoint returns the same envelope.

```jsonc
// success
{ "success": true, "message": "Blog posts retrieved", "data": [...], "meta": { ... } }

// error
{ "success": false, "message": "Validation failed", "errors": [{ "field": "title", "message": "Title is required" }] }
```

`meta` appears only on paginated listings.

Field names on the wire are **snake_case** (`image_url`, `sort_order`, `published_at`,
`assigned_team_members`), exactly as the React app already reads them. Requests accept
either casing.

---

## Authentication

JWT access token (15 min) + rotating refresh token (30 days, stored hashed).

```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@ghlprime.com","password":"Admin@12345"}'
```

```jsonc
{
  "success": true,
  "data": {
    "access_token": "eyJhbG...",
    "refresh_token": "eyJhbG...",
    "token_type": "Bearer",
    "expires_in": 900,
    "user": { "id": "...", "email": "admin@ghlprime.com", "role": "ADMIN" }
  }
}
```

Send it as `Authorization: Bearer <access_token>`. The refresh token is also set as an
httpOnly cookie, so browser clients can call `POST /auth/refresh` with no body.

**Roles:** `ADMIN` (everything, incl. user management), `EDITOR` (all content),
`VIEWER` (read-only).

Public reads stay public. Every write requires `ADMIN` or `EDITOR`. Reading drafts
requires a token — the replacement for the old
`"authenticated can read all blog posts"` RLS policy.

---

## API reference

**Full reference: [`docs/API.md`](docs/API.md)** — every endpoint with its full
URL, all request and response fields, error codes, and the data model.
Deploying: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Vercel) ·
[`docs/SUPABASE.md`](docs/SUPABASE.md) (Supabase as the database).

The summary below is the quick index. Base URL: `/api/v1`

### Auth — `/auth`
| Method | Path | Access |
|---|---|---|
| POST | `/login` · `/refresh` · `/logout` | public |
| GET | `/me` · `/session` | auth |
| POST | `/change-password` | auth |
| POST | `/register` | admin |
| GET · PATCH · DELETE | `/users` · `/users/:id` | admin |

### Admin dashboard — `/dashboard`
| Method | Path | Returns |
|---|---|---|
| GET | `/summary` | counts + recent activity in one call |
| GET | `/counts` | per-collection totals, published/draft splits, new-lead counts |
| GET | `/recent` | the five most recently touched records per collection |

### Case studies — `/case-studies`
| Method | Path | Access |
|---|---|---|
| GET | `/` `?category=&search=` | public (published) |
| GET | `/admin` | auth (incl. drafts) |
| GET | `/categories` | public |
| GET | `/slug/:slug` | public (drafts with a token) |
| GET | `/:id` | public |
| POST · PUT/PATCH · DELETE | `/` · `/:id` | auth |

Accepts `teamMemberIds: string[]` to set the credited team; responses embed
`assigned_team_members[].team_member`. Slugs are generated from the title when omitted.

### Blog — `/blog`
| Method | Path | Access |
|---|---|---|
| GET | `/` `?category=&search=&featured=&page=&limit=` | public (published) |
| GET | `/admin` | auth (incl. drafts) |
| GET | `/categories` · `/related?category=&exclude=&limit=` | public |
| GET | `/slug/:slug` · `/:id` | public |
| POST · PUT/PATCH · DELETE | `/` · `/:id` | auth |

Setting `published: true` without a `published_at` stamps it automatically.

### Sortable resources
`/team/members`, `/team/experts`, `/gallery/categories`, `/gallery/images`,
`/meeting-gallery`, `/partner-logos`, `/technology-logos`, `/showcase/items`,
`/showcase/stats` all share one shape:

| Method | Path | Access |
|---|---|---|
| GET | `/` | public (published, display order) |
| GET | `/admin` | auth (all rows) |
| PATCH | `/reorder` | auth — `{ "items": [{ "id": "...", "sort_order": 1 }] }` |
| GET | `/:id` | public |
| POST · PUT/PATCH · DELETE | `/` · `/:id` | auth |

Extras:
- `GET /team` — alias for `/team/members`
- `GET /gallery` — categories + images in one response
- `GET /gallery/images/by-category/:categoryId`
- `GET /showcase/page/:pageKey` — items + stats for `home` or `service:<slug>`
- `GET /showcase/items/page/:pageKey` — items only

Showcase items accept a `placements` array (`[{ page_key, sort_order, enabled }]`),
replaced wholesale on write.

### Contact — `/contact`
| Method | Path | Access |
|---|---|---|
| POST | `/submit` | public (rate limited) |
| GET | `/leads?page=&limit=&search=&status=` | auth |
| GET | `/leads/stats` · `/leads/:id` | auth |
| PATCH | `/leads/:id/status` | auth |
| DELETE | `/leads/:id` | auth |

Stores every field the multi-step ContactPage collects — `ghl_situation`,
`client_volume`, `monthly_budget`, `timeline`, `biggest_challenge`, `country`, `role` —
which previously went straight to the CRM webhook and were never persisted.

Both spam checks from the old serverless handler are kept: the `website` honeypot, and
rejecting forms completed faster than `CONTACT_MIN_FILL_MS`. The lead is saved before
being forwarded, so a webhook outage never loses it.

### Service surveys — `/service-surveys`
| Method | Path | Access |
|---|---|---|
| POST | `/submit` | public (rate limited) |
| GET | `/submissions?page=&limit=&search=&status=` | auth |
| GET | `/submissions/stats` · `/submissions/:id` | auth |
| GET | `/by-service` | auth — submissions per service page |
| PATCH | `/submissions/:id/status` | auth |
| DELETE | `/submissions/:id` | auth |

Backs `ServiceSurveyForm.jsx` on every `/services/*` page. Accepts the exact payload it
already builds and forwards the same field names to `SURVEY_WEBHOOK_URL`.

### Image uploads — `/uploads`

Local files are uploaded to **Cloudinary**. Nothing is written to the API
server's disk: multer keeps the file in memory and it is streamed straight to
Cloudinary, so there is no temp directory to clean up.

| Method | Path | Access |
|---|---|---|
| GET | `/status` | public — is uploading configured, and what are the limits |
| POST | `/image` | auth — `multipart/form-data`, field `file` |
| POST | `/images` | auth — `multipart/form-data`, field `files` (many) |
| GET | `/` `?page=&limit=&search=` | auth — the media library |
| GET | `/signature` `?folder=` | auth — for signed browser-direct uploads |
| DELETE | `/:id` | auth — by media-asset id |
| DELETE | `/public-id/<folder>/<name>` | auth — by Cloudinary `public_id` |

Upload an image:

```bash
curl -X POST http://localhost:4000/api/v1/uploads/image \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./team-photo.png" \
  -F "alt=Team photo" \
  -F "folder=ghlprime/team"
```

```jsonc
{
  "success": true,
  "message": "Image uploaded successfully",
  "data": {
    "id": "…",
    "public_id": "ghlprime/team/abc123",
    "secure_url": "https://res.cloudinary.com/<cloud>/image/upload/v1/…png",
    "format": "png", "width": 1200, "height": 800, "bytes": 48210
  }
}
```

Put `secure_url` into whichever `image_url` field you are editing — the content
tables store a plain URL string, exactly as before.

Optional multipart text fields: `folder`, `alt`, `tags` (comma-separated).

**Uploads are transformed on delivery** with `fetch_format: auto` and
`quality: auto`, so Cloudinary serves WebP/AVIF to browsers that support it.

**Constraints** — `MAX_UPLOAD_SIZE_MB` (default 10) per file,
`MAX_UPLOAD_FILES` (default 10) per request, and image MIME types only
(jpeg, png, webp, gif, avif, svg, bmp, tiff). Violations return 400 with a
specific message.

**Deleting** removes the Cloudinary asset *first*, then the local row — so a
remote failure leaves the record intact instead of orphaning the file.

**Before credentials are set:** the API boots normally, logs a warning, and every
other route works. `GET /uploads/status` returns `configured: false` so the admin
UI can disable its file picker, and upload attempts return **503** with
`CLOUDINARY_NOT_CONFIGURED` and a message naming the exact variables to set —
503 rather than 500 because nothing is broken and the caller did nothing wrong.

> **Note on SVG:** `image/svg+xml` is accepted. SVGs can embed scripts, but
> Cloudinary serves them from `res.cloudinary.com`, not your own domain, so they
> cannot script against your site's origin. Drop it from `ALLOWED_MIME_TYPES` in
> `src/shared/middleware/upload.ts` if you would rather not accept them at all.

### Sitemap — `/sitemap`
| Method | Path | Access |
|---|---|---|
| POST | `/refresh` | public, or token-guarded via `SITEMAP_REFRESH_TOKEN` |
| GET | `/xml` | public |

Also served at `GET /sitemap.xml`. `GET|POST /free-scripts` returns 410 Gone, as before.

### Health — `/health`
`GET /health` (liveness) · `GET /health/db` (database round-trip)

---

## Lead pipeline

Both lead types share a `status` enum — `NEW → CONTACTED → QUALIFIED → WON / LOST /
ARCHIVED` — plus a free-text `notes` field, so the admin panel can work an inbox rather
than just read a log.

---

## Environment

See `.env.example`. Required: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`.
`env.ts` validates everything at boot and exits with a readable message if something is
missing, rather than failing later at request time.

`DIRECT_URL` is the unpooled Neon connection used for migrations; `DATABASE_URL` is the
pooled one used at runtime.

**Cloudinary** is optional at boot. Set either the three discrete variables:

```
CLOUDINARY_CLOUD_NAME=your-cloud
CLOUDINARY_API_KEY=123456789012345
CLOUDINARY_API_SECRET=your-secret
```

…or the single URL form, which the SDK reads on its own:

```
CLOUDINARY_URL=cloudinary://123456789012345:your-secret@your-cloud
```

Both are found under *Settings → API Keys* in the Cloudinary dashboard. No
restart-time validation is applied to them, so the API never fails to start over
a missing image key — `/uploads/*` simply reports that it is unconfigured.

Generate real secrets before deploying:

```bash
openssl rand -base64 48
```

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch-mode server (tsx) |
| `npm run build` | `prisma generate` + `tsc` → `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run prisma:generate` · `prisma:push` · `prisma:migrate` · `prisma:studio` | Prisma tooling |
| `npm run db:seed` | Seed content + admin (idempotent) |
| `npm run db:setup` | Push the schema, then seed |
| `npm run db:check` | Validate connection strings, schema and (on Supabase) public-API exposure |
| `npm run content:list` | List importable content sources |
| `npm run content:import -- --source=july-blogs [--publish] [--dry-run]` | Import a content batch |
| `npm run sitemap:refresh` | Rebuild `public/sitemap.xml` |
| `npm run verify:uploads` | Exercise the Cloudinary upload path against a stubbed SDK (no credentials or network needed) |
| `npm run routes` | Print every registered route, straight from the Express router |
| `npm run test:api` | Exercise all 144 endpoints against a running server and report coverage |

`content:import` replaces the old one-off Supabase publish scripts
(`seed-blog-posts`, `publish-july-blogs`, `publish-keyword-blogs`,
`seed-case-studies`), which were all the same "read a data module, upsert by slug"
routine.

---

## Migrating from Supabase

The existing tables are unchanged (`@@map` preserves every table and column name), so
existing rows keep working. What changed:

| Before | Now |
|---|---|
| `supabase.from('x').select()` in the browser | `GET /api/v1/x` |
| `supabase.auth.signInWithPassword()` | `POST /api/v1/auth/login` |
| RLS policies | `authenticate` + `authorize` middleware |
| `/api/contact-submit` (Vercel) | `POST /api/v1/contact/submit` |
| `/api/refresh-sitemap` (Vercel) | `POST /api/v1/sitemap/refresh` |
| `/api/gone` (Vercel) | `GET /free-scripts` → 410 |
| Mongo `server/` case-study API | `/api/v1/case-studies` |
| Survey form → webhook only | `POST /api/v1/service-surveys/submit` (persisted) |

### Frontend `lib` → endpoint map

| `src/lib` function | Endpoint |
|---|---|
| `signInWithPassword` / `signOut` / `getSession` | `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` |
| `fetchCaseStudies` / `fetchCaseStudyBySlug` | `GET /case-studies` · `GET /case-studies/slug/:slug` |
| `fetchAdminCaseStudies` / `createCaseStudy` / `updateCaseStudy` | `GET /case-studies/admin` · `POST` · `PATCH /case-studies/:id` |
| `fetchBlogPosts` / `fetchBlogPostBySlug` / `fetchRelatedPosts` | `GET /blog` · `GET /blog/slug/:slug` · `GET /blog/related` |
| `fetchAdminBlogPosts` / `create` / `update` / `deleteBlogPost` | `GET /blog/admin` · `POST` · `PATCH` · `DELETE /blog/:id` |
| `fetchTeamMembers` / `create` / `update` / `deleteTeamMember` | `/team/members` |
| `fetchTeamPageExperts` / `create` / `update` / `delete` | `/team/experts` |
| `fetchGalleryCategories` / `fetchGalleryImages` (+ admin CRUD) | `/gallery/categories` · `/gallery/images` |
| `fetchPartnerLogos` (+ admin CRUD) | `/partner-logos` |
| `fetchTechnologyLogos` (+ admin CRUD) | `/technology-logos` |
| `fetchMeetingGallery` (+ admin CRUD) | `/meeting-gallery` |
| `fetchShowcaseForPage` / `fetchShowcaseStats` (+ admin CRUD) | `/showcase/items/page/:pageKey` · `/showcase/stats` |

Response field names are identical to what Supabase returned, so component code does
not change — only the transport inside those `lib` files.

Note that `caseStudiesApi.js` never had a delete function; `DELETE /case-studies/:id`
exists here so the admin panel can offer one.
