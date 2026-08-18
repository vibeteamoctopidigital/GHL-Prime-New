# GHL Prime API — Route Reference

Every endpoint, with its full URL.

| | |
|---|---|
| **Local base URL** | `http://localhost:4000` |
| **Production base URL** | `https://<your-project>.vercel.app` |
| **API prefix** | `/api` |
| **Total endpoints** | 147 |
| **Content type** | `application/json` (uploads use `multipart/form-data`) |
| **Database** | Supabase PostgreSQL, accessed over PostgREST |
| **Image storage** | Cloudinary |

URLs below are written against `http://localhost:4000`. On production, swap the
host — everything after it is identical.

Regenerate the live route table with `npm run routes`, and verify every endpoint
with `npm run test:api`.

---

## Contents

| Section | Base route |
|---|---|
| [1. Conventions](#1-conventions) | — |
| [2. Errors](#2-errors) | — |
| [3. Auth](#3-auth) | `http://localhost:4000/api/auth` |
| [4. Dashboard](#4-dashboard) | `http://localhost:4000/api/dashboard` |
| [5. Case studies](#5-case-studies) | `http://localhost:4000/api/case-studies` |
| [6. Blog](#6-blog) | `http://localhost:4000/api/blog` |
| [7. Team](#7-team) | `http://localhost:4000/api/team` |
| [8. Gallery](#8-gallery) | `http://localhost:4000/api/gallery` |
| [9. Meeting gallery](#9-meeting-gallery) | `http://localhost:4000/api/meeting-gallery` |
| [10. Partner logos](#10-partner-logos) | `http://localhost:4000/api/partner-logos` |
| [11. Technology logos](#11-technology-logos) | `http://localhost:4000/api/technology-logos` |
| [12. Showcase](#12-showcase) | `http://localhost:4000/api/showcase` |
| [13. Contact](#13-contact) | `http://localhost:4000/api/contact` |
| [14. Service surveys](#14-service-surveys) | `http://localhost:4000/api/service-surveys` |
| [15. Image uploads](#15-image-uploads) | `http://localhost:4000/api/uploads` |
| [16. Sitemap](#16-sitemap) | `http://localhost:4000/api/sitemap` |
| [17. Health](#17-health) | `http://localhost:4000/api/health` |
| [18. Root & compatibility](#18-root--compatibility) | `http://localhost:4000/` |
| [19. Data model](#19-data-model) | — |

**Access legend** — 🌐 Public · 🔒 Auth (`ADMIN` or `EDITOR`) · 👑 Admin only

---

## 1. Conventions

### Response envelope

```jsonc
// Success
{ "success": true, "message": "Blog posts retrieved", "data": [...], "meta": {...} }

// Failure
{ "success": false, "message": "Validation failed",
  "errors": [{ "field": "title", "message": "Title is required" }] }
```

`meta` appears only on paginated listings.

### Field naming

Responses use **snake_case** (`image_url`, `sort_order`, `published_at`).
Requests accept **either** casing — `imageUrl` and `image_url` both work.

### Authentication header

```
Authorization: Bearer <access_token>
```

### Pagination

`?page=` and `?limit=` (limit capped at 100) add:

```jsonc
"meta": { "page": 1, "limit": 20, "total": 50, "totalPages": 3,
          "hasNextPage": true, "hasPreviousPage": false }
```

### The `/admin` convention

A public list route returns only published rows. The matching `/admin` route
requires a token and returns **everything including drafts**.

### Sorting

Sortable collections order by `sort_order` ascending, then `created_at`.
Omitting `sort_order` on create defaults to `999`; omitting it on update leaves
the existing value alone.

### Rate limits

| Applies to | Limit | Window |
|---|---|---|
| Everything under `/api` | 300 req | 15 min |
| `/auth/login`, `/auth/refresh` | 10 req | 15 min |
| `/contact/submit`, `/service-surveys/submit` | 20 req | 1 hour |

### The prefix is fixed

Every route lives under `/api`. That is a constant in `src/config/constants.ts`,
**not** an environment variable — a stale `API_PREFIX` in a deployment's settings
would otherwise move the whole API and make every documented URL 404, which is
near-impossible to diagnose from outside. Versioning, if ever wanted, is a
deliberate one-line change there.

### Base paths are browsable

Hitting a module's base path in a browser lists what lives underneath it:

```bash
curl http://localhost:4000/api          # every module
curl http://localhost:4000/api/auth     # every auth endpoint
```

So a prefix never answers with a bare "Route not found".

---

## 2. Errors

| Status | Meaning | Typical cause |
|---|---|---|
| `400` | Bad Request | Malformed JSON; bad upload (wrong type, too large) |
| `401` | Unauthorized | Missing/expired/invalid token, wrong credentials |
| `403` | Forbidden | Role insufficient; disallowed CORS origin |
| `404` | Not Found | No such record or route |
| `409` | Conflict | Duplicate email or slug |
| `410` | Gone | Retired URL (`/free-scripts`) |
| `422` | Unprocessable | Validation failed — see `errors[]` |
| `429` | Too Many Requests | Rate limit exceeded |
| `500` | Server Error | Unexpected fault (hidden in production) |
| `502` | Bad Gateway | Upstream failed (CRM webhook, Cloudinary) |
| `503` | Service Unavailable | Dependency not configured (Cloudinary keys absent) |

---

## 3. Auth

**Base path:** `http://localhost:4000/api/auth` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 0 | `GET` | `http://localhost:4000/api/auth` | 🌐 — lists these endpoints |
| 1 | `POST` | `http://localhost:4000/api/auth/login` | 🌐 |
| 2 | `POST` | `http://localhost:4000/api/auth/refresh` | 🌐 |
| 3 | `POST` | `http://localhost:4000/api/auth/logout` | 🌐 |
| 4 | `GET` | `http://localhost:4000/api/auth/me` | 🔒 |
| 5 | `GET` | `http://localhost:4000/api/auth/session` | 🔒 |
| 6 | `POST` | `http://localhost:4000/api/auth/change-password` | 🔒 |
| 7 | `POST` | `http://localhost:4000/api/auth/register` | 👑 |
| 8 | `GET` | `http://localhost:4000/api/auth/users` | 👑 |
| 9 | `PATCH` | `http://localhost:4000/api/auth/users/:id` | 👑 |
| 10 | `DELETE` | `http://localhost:4000/api/auth/users/:id` | 👑 |

### `POST` http://localhost:4000/api/auth/login 🌐

**Body** — `email` (required), `password` (required)

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@ghlprime.com","password":"Admin@12345"}'
```

```jsonc
{
  "success": true,
  "message": "Signed in successfully",
  "data": {
    "access_token": "eyJhbGciOi…",     // 15 min
    "refresh_token": "eyJhbGciOi…",    // 30 days, also an httpOnly cookie
    "token_type": "Bearer",
    "expires_in": 900,
    "user": { "id": "…", "email": "admin@ghlprime.com", "full_name": "GHL Prime Admin",
              "role": "ADMIN", "is_active": true, "last_login_at": "…" }
  }
}
```

`401` on bad credentials — identical message whether or not the email exists, so
this cannot be used to enumerate accounts. `403` if deactivated.

### `POST` http://localhost:4000/api/auth/refresh 🌐

**Body** — `refreshToken` (or rely on the cookie). The presented token is revoked
as it is spent; reusing it returns `401`.

### `POST` http://localhost:4000/api/auth/logout 🌐

Revokes the presented refresh token. With a bearer token and empty body, revokes
**every** session for that user.

### `GET` http://localhost:4000/api/auth/me 🔒
### `GET` http://localhost:4000/api/auth/session 🔒

The current user. `/session` is an alias — the admin panel uses it to restore a
session on load.

### `POST` http://localhost:4000/api/auth/change-password 🔒

**Body** — `currentPassword`, `newPassword` (min 8). Revokes all sessions on
success.

### `POST` http://localhost:4000/api/auth/register 👑

**Body** — `email`, `password` (min 8), `fullName?`, `role?`
(`ADMIN` · `EDITOR` · `VIEWER`, default `EDITOR`). `409` if the email exists.

### `GET` http://localhost:4000/api/auth/users 👑

All users. Password hashes are never returned.

### `PATCH` http://localhost:4000/api/auth/users/:id 👑

**Body** — any of `role`, `isActive`, `fullName`.

### `DELETE` http://localhost:4000/api/auth/users/:id 👑

Deletes the user; their refresh tokens cascade away.

### Roles

| Role | Can do |
|---|---|
| `ADMIN` | Everything, including user management |
| `EDITOR` | All content CRUD; **cannot** manage users |
| `VIEWER` | Read-only |

---

## 4. Dashboard

**Base path:** `http://localhost:4000/api/dashboard` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 0 | `GET` | `http://localhost:4000/api/dashboard` | 🌐 — lists these endpoints |
| 1 | `GET` | `http://localhost:4000/api/dashboard/summary` | 🔒 |
| 2 | `GET` | `http://localhost:4000/api/dashboard/counts` | 🔒 |
| 3 | `GET` | `http://localhost:4000/api/dashboard/recent` | 🔒 |

### `GET` http://localhost:4000/api/dashboard/counts 🔒

```jsonc
{
  "case_studies":  { "total": 17, "published": 17, "drafts": 0 },
  "blog_posts":    { "total": 50, "published": 41, "drafts": 9 },
  "team_members": 2, "team_experts": 12,
  "gallery_categories": 1, "gallery_images": 3,
  "meeting_gallery": 10, "partner_logos": 19, "technology_logos": 21,
  "showcase_items": 16, "showcase_stats": 4,
  "contact_leads":   { "total": 0, "new": 0 },
  "service_surveys": { "total": 0, "new": 0 }
}
```

`/summary` returns `counts` **and** `recent` in one request — built so the admin
landing page does not have to fetch every collection just to count it.
`/recent` returns the five most recently touched case studies, blog posts,
contact leads and service surveys.

---

## 5. Case studies

**Base path:** `http://localhost:4000/api/case-studies` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/case-studies` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/case-studies/admin` | 🔒 |
| 3 | `GET` | `http://localhost:4000/api/case-studies/categories` | 🌐 |
| 4 | `GET` | `http://localhost:4000/api/case-studies/slug/:slug` | 🌐 |
| 5 | `GET` | `http://localhost:4000/api/case-studies/:id` | 🌐 |
| 6 | `POST` | `http://localhost:4000/api/case-studies` | 🔒 |
| 7 | `PUT` | `http://localhost:4000/api/case-studies/:id` | 🔒 |
| 8 | `PATCH` | `http://localhost:4000/api/case-studies/:id` | 🔒 |
| 9 | `DELETE` | `http://localhost:4000/api/case-studies/:id` | 🔒 |

**Query (`GET /`)** — `category`, `search` (title, category, excerpt, subtitle)

```bash
curl "http://localhost:4000/api/case-studies?category=Automation&search=lead"
curl http://localhost:4000/api/case-studies/slug/dental-recall-no-show-automation-ghl
```

With a valid token, `/slug/:slug` resolves drafts too; without one, only
published.

**Body fields**

| Field | Type | Notes |
|---|---|---|
| `title` | string | **Required** |
| `category` | string | **Required** |
| `slug` | string | Auto-generated from `title`; uniqueness enforced |
| `subtitle`, `challenge`, `solution`, `outcome`, `excerpt`, `image`, `accent` | string | Optional |
| `body` | array | Rich-text blocks; a JSON string is parsed |
| `featured`, `published` | boolean | Accepts `true/false/"1"/"yes"` |
| `teamMemberIds` | string[] | UUIDs — **replaces** the credited team wholesale |

**Response embed** — each study carries its credited team in the shape the
frontend already reads:

```jsonc
{
  "id": "…", "slug": "…", "title": "…", "category": "Automation",
  "body": ["paragraph one", "paragraph two"],
  "featured": false, "published": true, "created_at": "…", "updated_at": "…",
  "assigned_team_members": [
    { "id": "…", "case_study_id": "…", "team_member_id": "…",
      "team_member": { "id": "…", "name": "Jewel Rana", "role": "CEO & Co-Founder" } }
  ]
}
```

Create, update and delete each trigger a sitemap refresh.

---

## 6. Blog

**Base path:** `http://localhost:4000/api/blog` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/blog` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/blog/admin` | 🔒 |
| 3 | `GET` | `http://localhost:4000/api/blog/categories` | 🌐 |
| 4 | `GET` | `http://localhost:4000/api/blog/related` | 🌐 |
| 5 | `GET` | `http://localhost:4000/api/blog/slug/:slug` | 🌐 |
| 6 | `GET` | `http://localhost:4000/api/blog/:id` | 🌐 |
| 7 | `POST` | `http://localhost:4000/api/blog` | 🔒 |
| 8 | `PUT` | `http://localhost:4000/api/blog/:id` | 🔒 |
| 9 | `PATCH` | `http://localhost:4000/api/blog/:id` | 🔒 |
| 10 | `DELETE` | `http://localhost:4000/api/blog/:id` | 🔒 |

**Query (`GET /`)** — `category`, `search`, `featured`, `page`, `limit`.
Supplying `page` or `limit` switches the response to the paginated envelope.

```bash
curl "http://localhost:4000/api/blog?page=1&limit=10&category=Automation"
curl "http://localhost:4000/api/blog/related?category=Automation&exclude=my-post&limit=3"
```

`/related` requires `category`; omitting it returns `422`.

**Body fields**

| Field | Type | Notes |
|---|---|---|
| `title`, `category` | string | **Required** |
| `slug` | string | Auto-generated from `title`; `409` on collision |
| `tags` | string[] | Also accepts a comma-separated string |
| `author` | string | Defaults `"GHL Prime Team"` |
| `excerpt`, `content`, `cover_image` | string | Optional |
| `reading_time` | integer | Minutes |
| `seo_title`, `seo_description`, `seo_keywords` | string | Optional |
| `featured`, `published` | boolean | |
| `published_at` | ISO date | Auto-stamped on first publish |

---

## 7. Team

**Base path:** `http://localhost:4000/api/team` — a `GET` here lists the endpoints below.

Two separate collections:

- **`/team/members`** — leadership profiles (`/admin/leaders`)
- **`/team/experts`** — "Meet The Experts" profiles (`/admin/experts`)

`/team` with no sub-path is an **alias for `/team/members`**.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/team` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/team/admin` | 🔒 |
| 3 | `PATCH` | `http://localhost:4000/api/team/reorder` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/team/:id` | 🌐 |
| 5 | `POST` | `http://localhost:4000/api/team` | 🔒 |
| 6 | `PUT` | `http://localhost:4000/api/team/:id` | 🔒 |
| 7 | `PATCH` | `http://localhost:4000/api/team/:id` | 🔒 |
| 8 | `DELETE` | `http://localhost:4000/api/team/:id` | 🔒 |
| 9 | `GET` | `http://localhost:4000/api/team/members` | 🌐 |
| 10 | `GET` | `http://localhost:4000/api/team/members/admin` | 🔒 |
| 11 | `PATCH` | `http://localhost:4000/api/team/members/reorder` | 🔒 |
| 12 | `GET` | `http://localhost:4000/api/team/members/:id` | 🌐 |
| 13 | `POST` | `http://localhost:4000/api/team/members` | 🔒 |
| 14 | `PUT` | `http://localhost:4000/api/team/members/:id` | 🔒 |
| 15 | `PATCH` | `http://localhost:4000/api/team/members/:id` | 🔒 |
| 16 | `DELETE` | `http://localhost:4000/api/team/members/:id` | 🔒 |
| 17 | `GET` | `http://localhost:4000/api/team/experts` | 🌐 |
| 18 | `GET` | `http://localhost:4000/api/team/experts/admin` | 🔒 |
| 19 | `PATCH` | `http://localhost:4000/api/team/experts/reorder` | 🔒 |
| 20 | `GET` | `http://localhost:4000/api/team/experts/:id` | 🌐 |
| 21 | `POST` | `http://localhost:4000/api/team/experts` | 🔒 |
| 22 | `PUT` | `http://localhost:4000/api/team/experts/:id` | 🔒 |
| 23 | `PATCH` | `http://localhost:4000/api/team/experts/:id` | 🔒 |
| 24 | `DELETE` | `http://localhost:4000/api/team/experts/:id` | 🔒 |

### Leader fields (`/team/members`)

`name` (**required**), `role` (**required**), `description`, `image_url`,
`sort_order`, plus `linkedin_url`, `facebook_url`, `instagram_url`,
`twitter_url`, `upwork_url`, `website_url`.

> `team_members` has **no `published` column** — every leader is public, matching
> the original schema. `GET /team/members` therefore returns all rows.

### Expert fields (`/team/experts`)

`name`, `title`, `image_url` — **all three required**, because those columns are
`NOT NULL` in the live table — plus `sort_order` and `published`.

### `PATCH` .../reorder 🔒

```bash
curl -X PATCH http://localhost:4000/api/team/members/reorder \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"uuid-a","sort_order":1},{"id":"uuid-b","sort_order":2}]}'
```

Applied as a single upsert, which Postgres executes atomically — the list is
never observed half-reordered.

---

## 8. Gallery

**Base path:** `http://localhost:4000/api/gallery` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/gallery` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/gallery/categories` | 🌐 |
| 3 | `GET` | `http://localhost:4000/api/gallery/categories/admin` | 🔒 |
| 4 | `PATCH` | `http://localhost:4000/api/gallery/categories/reorder` | 🔒 |
| 5 | `GET` | `http://localhost:4000/api/gallery/categories/:id` | 🌐 |
| 6 | `POST` | `http://localhost:4000/api/gallery/categories` | 🔒 |
| 7 | `PUT` | `http://localhost:4000/api/gallery/categories/:id` | 🔒 |
| 8 | `PATCH` | `http://localhost:4000/api/gallery/categories/:id` | 🔒 |
| 9 | `DELETE` | `http://localhost:4000/api/gallery/categories/:id` | 🔒 |
| 10 | `GET` | `http://localhost:4000/api/gallery/images` | 🌐 |
| 11 | `GET` | `http://localhost:4000/api/gallery/images/admin` | 🔒 |
| 12 | `GET` | `http://localhost:4000/api/gallery/images/by-category/:categoryId` | 🌐 |
| 13 | `PATCH` | `http://localhost:4000/api/gallery/images/reorder` | 🔒 |
| 14 | `GET` | `http://localhost:4000/api/gallery/images/:id` | 🌐 |
| 15 | `POST` | `http://localhost:4000/api/gallery/images` | 🔒 |
| 16 | `PUT` | `http://localhost:4000/api/gallery/images/:id` | 🔒 |
| 17 | `PATCH` | `http://localhost:4000/api/gallery/images/:id` | 🔒 |
| 18 | `DELETE` | `http://localhost:4000/api/gallery/images/:id` | 🔒 |

`GET /api/gallery` returns everything the `/gallery` page needs in one request:

```jsonc
{ "success": true, "data": { "categories": [ … ], "images": [ … ] } }
```

**Category fields** — `name` (**required**), `slug` (auto-generated, unique),
`sort_order`, `published`.
**Image fields** — `image_url` (**required**), `title`, `category_id` (UUID or
`null`), `sort_order`, `published`.

> Deleting a category sets its images' `category_id` to `null` rather than
> deleting them.

---

## 9. Meeting gallery

**Base path:** `http://localhost:4000/api/meeting-gallery` — a `GET` here lists the endpoints below.

The homepage meeting-image strip.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/meeting-gallery` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/meeting-gallery/admin` | 🔒 |
| 3 | `PATCH` | `http://localhost:4000/api/meeting-gallery/reorder` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/meeting-gallery/:id` | 🌐 |
| 5 | `POST` | `http://localhost:4000/api/meeting-gallery` | 🔒 |
| 6 | `PUT` | `http://localhost:4000/api/meeting-gallery/:id` | 🔒 |
| 7 | `PATCH` | `http://localhost:4000/api/meeting-gallery/:id` | 🔒 |
| 8 | `DELETE` | `http://localhost:4000/api/meeting-gallery/:id` | 🔒 |

**Fields** — `image_url` (**required**), `title`, `sort_order`, `published`.

---

## 10. Partner logos

**Base path:** `http://localhost:4000/api/partner-logos` — a `GET` here lists the endpoints below.

The "trusted by" strip.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/partner-logos` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/partner-logos/admin` | 🔒 |
| 3 | `PATCH` | `http://localhost:4000/api/partner-logos/reorder` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/partner-logos/:id` | 🌐 |
| 5 | `POST` | `http://localhost:4000/api/partner-logos` | 🔒 |
| 6 | `PUT` | `http://localhost:4000/api/partner-logos/:id` | 🔒 |
| 7 | `PATCH` | `http://localhost:4000/api/partner-logos/:id` | 🔒 |
| 8 | `DELETE` | `http://localhost:4000/api/partner-logos/:id` | 🔒 |

**Fields** — `name` **or** `company_name` (**one required**), `image_url`,
`website_url`, `sort_order`, `published`.

> **Naming quirk, handled for you.** The stored column is `company_name`, but the
> frontend reads `name` on some screens and `company_name` on others. Every
> response emits **both**; input accepts `name`, `company_name` or `companyName`.

---

## 11. Technology logos

**Base path:** `http://localhost:4000/api/technology-logos` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/technology-logos` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/technology-logos/admin` | 🔒 |
| 3 | `PATCH` | `http://localhost:4000/api/technology-logos/reorder` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/technology-logos/:id` | 🌐 |
| 5 | `POST` | `http://localhost:4000/api/technology-logos` | 🔒 |
| 6 | `PUT` | `http://localhost:4000/api/technology-logos/:id` | 🔒 |
| 7 | `PATCH` | `http://localhost:4000/api/technology-logos/:id` | 🔒 |
| 8 | `DELETE` | `http://localhost:4000/api/technology-logos/:id` | 🔒 |

**Fields** — `name` (**required**), `image_url` (**required**), `sort_order`,
`published`.

---

## 12. Showcase

**Base path:** `http://localhost:4000/api/showcase` — a `GET` here lists the endpoints below.

The "Shipped Evidence" section: paired origin → enterprise-adaptation cards plus
a stat bar, placed per page.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/showcase/page/:pageKey` | 🌐 |
| 2 | `GET` | `http://localhost:4000/api/showcase/items` | 🌐 |
| 3 | `GET` | `http://localhost:4000/api/showcase/items/admin` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/showcase/items/page/:pageKey` | 🌐 |
| 5 | `PATCH` | `http://localhost:4000/api/showcase/items/reorder` | 🔒 |
| 6 | `GET` | `http://localhost:4000/api/showcase/items/:id` | 🌐 |
| 7 | `POST` | `http://localhost:4000/api/showcase/items` | 🔒 |
| 8 | `PUT` | `http://localhost:4000/api/showcase/items/:id` | 🔒 |
| 9 | `PATCH` | `http://localhost:4000/api/showcase/items/:id` | 🔒 |
| 10 | `DELETE` | `http://localhost:4000/api/showcase/items/:id` | 🔒 |
| 11 | `GET` | `http://localhost:4000/api/showcase/stats` | 🌐 |
| 12 | `GET` | `http://localhost:4000/api/showcase/stats/admin` | 🔒 |
| 13 | `PATCH` | `http://localhost:4000/api/showcase/stats/reorder` | 🔒 |
| 14 | `GET` | `http://localhost:4000/api/showcase/stats/:id` | 🌐 |
| 15 | `POST` | `http://localhost:4000/api/showcase/stats` | 🔒 |
| 16 | `PUT` | `http://localhost:4000/api/showcase/stats/:id` | 🔒 |
| 17 | `PATCH` | `http://localhost:4000/api/showcase/stats/:id` | 🔒 |
| 18 | `DELETE` | `http://localhost:4000/api/showcase/stats/:id` | 🔒 |

```bash
curl http://localhost:4000/api/showcase/page/home
curl http://localhost:4000/api/showcase/page/service:ghl-setup
```

`pageKey` is `home` or `service:<slug>`. Returns `{ items, stats }`.

**Item fields** — `origin_name` (**required**), `adaptation_name`
(**required**), `origin_url`, `origin_icon`, `origin_description`,
`origin_tagline`, `adaptation_badge`, `adaptation_description`,
`adaptation_tags` (array or comma-separated), `sort_order`, `published`, plus:

```jsonc
"placements": [ { "page_key": "home", "sort_order": 1, "enabled": true } ]
```

Placements are **replaced wholesale** on write. Omitting the key leaves them
alone; sending `[]` clears them. Deleting an item cascades to its placements.

**Stat fields** — `value` (**required**), `label` (**required**), `sort_order`,
`published`.

---

## 13. Contact

**Base path:** `http://localhost:4000/api/contact` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `POST` | `http://localhost:4000/api/contact/submit` | 🌐 20/hr |
| 2 | `GET` | `http://localhost:4000/api/contact/leads` | 🔒 |
| 3 | `GET` | `http://localhost:4000/api/contact/leads/stats` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/contact/leads/:id` | 🔒 |
| 5 | `PATCH` | `http://localhost:4000/api/contact/leads/:id/status` | 🔒 |
| 6 | `DELETE` | `http://localhost:4000/api/contact/leads/:id` | 🔒 |

### `POST` http://localhost:4000/api/contact/submit 🌐

Accepts both the original payload and the richer multi-step ContactPage payload.

| Field | Notes |
|---|---|
| `email` | **Required**, validated |
| `name` / `fullName` | Either spelling |
| `company` / `business` / `business_name` | Any of the three |
| `phone`, `country`, `role`, `message`, `source` | Optional |
| `ghl_situation`, `client_volume`, `monthly_budget`, `timeline`, `biggest_challenge` | Qualifying answers |
| `page_url` | Where it was submitted from |
| `website` | **Honeypot — must stay empty** |
| `formStartedAt` | Epoch ms when the form rendered |

```bash
curl -X POST http://localhost:4000/api/contact/submit \
  -H 'Content-Type: application/json' \
  -d '{"name":"Jane","email":"jane@acme.com","business_name":"Acme",
       "ghl_situation":"Messy setup","timeline":"ASAP","formStartedAt":1750000000000}'
```

**Spam handling** — a filled `website`, or a form completed faster than
`CONTACT_MIN_FILL_MS` (default 2500 ms), is treated as a bot: a normal `201`
with `{ "spam": true }` and **nothing stored**, so bots get no signal.

**Ordering guarantee** — the lead is saved to the database *first*, then
forwarded to the CRM webhook. A webhook outage returns `502`, but the lead is
already safe.

### Inbox

**Query (`GET /leads`)** — `page`, `limit`, `search`, `status`

```jsonc
PATCH /api/contact/leads/:id/status
{ "status": "QUALIFIED", "notes": "Good fit — booked a call" }
```

**Statuses** — `NEW` · `CONTACTED` · `QUALIFIED` · `WON` · `LOST` · `ARCHIVED`

---

## 14. Service surveys

**Base path:** `http://localhost:4000/api/service-surveys` — a `GET` here lists the endpoints below.

Submissions from the multi-step forms on every `/services/*` page.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `POST` | `http://localhost:4000/api/service-surveys/submit` | 🌐 20/hr |
| 2 | `GET` | `http://localhost:4000/api/service-surveys/submissions` | 🔒 |
| 3 | `GET` | `http://localhost:4000/api/service-surveys/submissions/stats` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/service-surveys/submissions/:id` | 🔒 |
| 5 | `GET` | `http://localhost:4000/api/service-surveys/by-service` | 🔒 |
| 6 | `PATCH` | `http://localhost:4000/api/service-surveys/submissions/:id/status` | 🔒 |
| 7 | `DELETE` | `http://localhost:4000/api/service-surveys/submissions/:id` | 🔒 |

**Fields** — `email` (**required**), `name`, `phone`, `business`, `service`
(which `/services/*` page), `source`, `role`, `business_type`, `stage`,
`app_type`, `needs`, `budget`, `sub_accounts`, `lead_volume`, `coverage`,
`details` (transcript of answers), `page_url`, plus the same `website` honeypot
and `formStartedAt` timing check as the contact form.

`GET /by-service` shows which service pages actually produce leads:

```jsonc
[ { "service": "/services/ghl-setup", "count": 12 },
  { "service": "/services/automation", "count": 5 } ]
```

Shares the same status pipeline as contact leads.

---

## 15. Image uploads

**Base path:** `http://localhost:4000/api/uploads` — a `GET` here lists the endpoints below.

Local files are uploaded to **Cloudinary**. The file is held in memory and
streamed straight through — nothing is written to the API server's disk.

| # | Method | Full URL | Access |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/uploads/status` | 🌐 |
| 2 | `POST` | `http://localhost:4000/api/uploads/image` | 🔒 |
| 3 | `POST` | `http://localhost:4000/api/uploads/images` | 🔒 |
| 4 | `GET` | `http://localhost:4000/api/uploads` | 🔒 |
| 5 | `GET` | `http://localhost:4000/api/uploads/signature` | 🔒 |
| 6 | `DELETE` | `http://localhost:4000/api/uploads/:id` | 🔒 |
| 7 | `DELETE` | `http://localhost:4000/api/uploads/public-id/<folder>/<name>` | 🔒 |

### `GET` http://localhost:4000/api/uploads/status 🌐

Lets the admin UI enable or disable its file picker before anyone tries.

```jsonc
{ "configured": true, "mode": "unsigned (preset: ghlprime)",
  "folder": "ghlprime", "max_file_size_mb": 10, "max_files": 10,
  "allowed_types": ["image/jpeg","image/png","image/webp","image/gif",
                    "image/avif","image/svg+xml","image/bmp","image/tiff"] }
```

### `POST` http://localhost:4000/api/uploads/image 🔒

`multipart/form-data`, file field **`file`**.

```bash
curl -X POST http://localhost:4000/api/uploads/image \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@./team-photo.png" \
  -F "alt=Team photo" \
  -F "folder=ghlprime/team" \
  -F "tags=team,2026"
```

```jsonc
{
  "success": true,
  "message": "Image uploaded successfully",
  "data": {
    "id": "…",
    "public_id": "ghlprime/vexrghyzgwbhjsziy6a5",
    "secure_url": "https://res.cloudinary.com/<cloud>/image/upload/v1/….png",
    "format": "png", "width": 1200, "height": 800, "bytes": 48210,
    "folder": "ghlprime", "original_filename": "team-photo.png",
    "alt": "Team photo", "tags": ["team","2026"], "created_at": "…"
  }
}
```

Take `secure_url` and store it in whichever `image_url` field you are editing.
Optional text fields: `folder`, `alt`, `tags` (comma-separated).

### `POST` http://localhost:4000/api/uploads/images 🔒

Same, with file field **`files`** repeated. Returns
`{ uploaded: [...], failed: [{ filename, reason }] }`. If *every* file fails, the
underlying error is returned rather than a misleading `201`.

### `GET` http://localhost:4000/api/uploads 🔒

The media library. **Query** — `page`, `limit`, `search`.

### `GET` http://localhost:4000/api/uploads/signature 🔒

A signature for uploading **straight from the browser to Cloudinary**, bypassing
this API. Use it for files above the size limit. **Query** — `folder`.

### `DELETE` http://localhost:4000/api/uploads/:id 🔒

Removes the media-library record and attempts to delete the remote file.

```jsonc
{ "public_id": "ghlprime/…", "deleted": true,
  "remote_deleted": false, "remote_error": "…" }
```

> **Read `remote_deleted`.** Deleting from Cloudinary requires the account's
> `delete` action. Where that is withheld, the local record is still removed —
> otherwise the media library would be un-prunable — but the file **remains in
> Cloudinary storage and keeps counting toward quota**. `remote_deleted: false`
> tells you that happened.

### Signed vs unsigned

`CLOUDINARY_UPLOAD_PRESET` selects the mode:

- **set** → unsigned upload through that preset. The preset authorises the
  upload rather than the API key, which is the only path that works on a product
  environment that denies keys the `create` action.
- **unset** → normal signed upload using the API key.

`GET /uploads/status` reports which mode is live.

### Constraints

| Rule | Default | Error |
|---|---|---|
| Max file size | 10 MB local · **4 MB on Vercel** | `400` |
| Max files per request | 10 | `400` |
| Allowed types | jpeg, png, webp, gif, avif, svg, bmp, tiff | `400` |
| Field name | must be `file` / `files` | `400` |

> On Vercel the limit clamps to 4 MB because the platform rejects request bodies
> over ~4.5 MB before the function runs. Use the signature flow for larger files.

### Failure modes

| Response | Meaning |
|---|---|
| `503 CLOUDINARY_NOT_CONFIGURED` | Credentials absent — the message names the variables to set |
| `502 CLOUDINARY_PRESET_NOT_FOUND` | `CLOUDINARY_UPLOAD_PRESET` names a preset that does not exist |
| `502 CLOUDINARY_FORBIDDEN` | Signed upload refused. Use an unsigned preset, or enable the `create` action |

---

## 16. Sitemap

**Base path:** `http://localhost:4000/api/sitemap` — a `GET` here lists the endpoints below.

| # | Method | Full URL | Access |
|---|---|---|---|
| 0 | `GET` | `http://localhost:4000/api/sitemap` | 🌐 — lists these endpoints |
| 1 | `POST` | `http://localhost:4000/api/sitemap/refresh` | Token-guarded |
| 2 | `GET` | `http://localhost:4000/api/sitemap/xml` | 🌐 |

Also served at `http://localhost:4000/sitemap.xml`.

`POST /refresh` is open when `SITEMAP_REFRESH_TOKEN` is empty. When set, present
it either way:

```bash
curl -X POST http://localhost:4000/api/sitemap/refresh \
  -H "Authorization: Bearer $SITEMAP_REFRESH_TOKEN"

curl -X POST http://localhost:4000/api/sitemap/refresh \
  -H "X-Sitemap-Token: $SITEMAP_REFRESH_TOKEN"
```

```jsonc
// Local (writes public/sitemap.xml)
{ "count": 68, "outputDir": "…/public", "written": true,  "mode": "file" }

// Serverless (read-only filesystem — served live instead)
{ "count": 68, "outputDir": null,       "written": false, "mode": "dynamic" }
```

The sitemap also refreshes automatically after a case study or blog post
changes, so this endpoint is mainly for deploy hooks and cron.

---

## 17. Health

| # | Method | Full URL | Description |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/api/health` | Liveness — the process is up |
| 2 | `GET` | `http://localhost:4000/api/health/db` | Readiness — Supabase round-trip with `latency_ms` |

Both public, suitable for a load-balancer or uptime probe.

```jsonc
{ "ok": true, "database": "connected", "latency_ms": 34 }
```

---

## 18. Root & compatibility

| # | Method | Full URL | Result |
|---|---|---|---|
| 1 | `GET` | `http://localhost:4000/` | Service banner |
| 2 | `GET` | `http://localhost:4000/api` | Self-describing index of every module |
| 3 | `GET` | `http://localhost:4000/sitemap.xml` | The sitemap |
| 4 | `ALL` | `http://localhost:4000/free-scripts` | `410 Gone` with an HTML body |

```jsonc
// GET /api
{
  "success": true,
  "data": {
    "name": "GHL Prime API", "version": "1.0.0", "environment": "development",
    "endpoints": [
      { "path": "/api/health", "description": "Liveness and database readiness" },
      { "path": "/api/auth",   "description": "JWT authentication and user management" }
      // …14 modules
    ]
  }
}
```

---

## 19. Data model

18 tables in Supabase PostgreSQL. The API reaches them over PostgREST with the
service-role key — there is no ORM and no Postgres connection string.

| Table | Purpose |
|---|---|
| `users` | Admin accounts (replaces Supabase Auth) |
| `refresh_tokens` | Hashed refresh tokens |
| `case_studies` | Case studies |
| `case_study_team_members` | Join: study ↔ credited member |
| `team_members` | Leadership profiles |
| `team_page_members` | "Meet The Experts" profiles |
| `blog_posts` | Blog |
| `partner_logos` | "Trusted by" logos |
| `technology_logos` | Tech-stack logos |
| `meeting_gallery` | Homepage image strip |
| `gallery_categories` | `/gallery` tabs |
| `gallery_images` | `/gallery` images |
| `showcase_items` | Shipped-Evidence cards |
| `showcase_stats` | Stat-bar tiles |
| `showcase_placements` | Which item on which page |
| `contact_leads` | Contact submissions |
| `service_surveys` | Service-page survey submissions |
| `media_assets` | Uploaded Cloudinary images |

**Enums** — `UserRole`: `ADMIN` · `EDITOR` · `VIEWER` ·
`LeadStatus`: `NEW` · `CONTACTED` · `QUALIFIED` · `WON` · `LOST` · `ARCHIVED`

### A note on transactions

PostgREST exposes no multi-statement transactions, which shapes two behaviours:

- **Reorder is atomic** — it reads the affected rows, merges the new positions,
  and writes them back as one upsert, which Postgres applies as a single
  statement.
- **Relation syncing is not** — replacing case-study credits or showcase
  placements is a delete followed by an insert. A failure between them leaves
  the parent with *none* rather than duplicates: visible and correctable, which
  is the safer direction.

---

## Appendix — verifying the API

```bash
npm run routes      # print every registered route
npm run test:api    # exercise all 147 endpoints and report coverage
```

`test:api` derives its checklist from the Express router itself, so an endpoint
added without a test is reported as uncovered rather than silently skipped.

> The suite spends ~8 of the 10 allowed login attempts. Running it twice inside
> the 15-minute auth window trips the limiter; restart the server (limits are
> in-memory) before re-running.
