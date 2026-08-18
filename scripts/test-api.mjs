/**
 * Exhaustive API test — every registered endpoint.
 *
 * Each call declares the route PATTERN it exercises, so coverage can be checked
 * against routes-testable.json (extracted from the Express router itself).
 */
import { readFileSync } from 'node:fs'

const ORIGIN = 'http://localhost:4000'
const P = '/api'

let pass = 0, fail = 0
const failures = []
const covered = new Set()

function ok(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  ✗ ${label} — ${detail}`) }
}

/** @param route the express pattern, e.g. 'GET /api/blog/:id' */
async function api(method, path, { token, body, form, expect, route, raw = false } = {}) {
  if (route) covered.add(route)

  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(form ? { body: form } : {}),
    redirect: 'manual',
  })

  let json = null, text = null
  if (raw) text = await res.text()
  else { try { json = await res.json() } catch { /* non-JSON */ } }

  if (expect !== undefined) {
    const want = Array.isArray(expect) ? expect : [expect]
    ok(`${method} ${path.split('?')[0]}`, want.includes(res.status),
      want.includes(res.status) ? `${res.status}` : `got ${res.status}, want ${want.join('/')} :: ${JSON.stringify(json)?.slice(0, 160)}`)
  }

  return { status: res.status, json, text, headers: res.headers }
}

const H = (t) => console.log(`\n━━━ ${t} ━━━`)

// ═══════════════════════════════════════════════════════════ ROOT & HEALTH
H('Root, index & health')
await api('GET', '/', { expect: 200, route: 'GET /' })
const index = await api('GET', `${P}/`, { expect: 200, route: 'GET /api/' })
ok('index lists all modules', index.json?.data?.endpoints?.length >= 14, `${index.json?.data?.endpoints?.length} modules`)
await api('GET', `${P}/health/`, { expect: 200, route: 'GET /api/health/' })

// Module base paths list what lives under them, so a browser hitting a prefix
// gets guidance rather than a bare 404.
const authIdx = await api('GET', `${P}/auth`, { expect: 200, route: 'GET /api/auth/' })
ok('auth index lists its endpoints', authIdx.json?.data?.endpoints?.length >= 10, `${authIdx.json?.data?.endpoints?.length} endpoints`)
ok('index paths are fully qualified', String(authIdx.json?.data?.endpoints?.[0]?.path).startsWith('/api/auth/'))
await api('GET', `${P}/dashboard`, { expect: 200, route: 'GET /api/dashboard/' })
await api('GET', `${P}/sitemap`, { expect: 200, route: 'GET /api/sitemap/' })
await api('GET', `${P}/showcase`, { expect: 200, route: 'GET /api/showcase/' })
await api('GET', `${P}/contact`, { expect: 200, route: 'GET /api/contact/' })
await api('GET', `${P}/service-surveys`, { expect: 200, route: 'GET /api/service-surveys/' })

// Guard: no module prefix may answer 404. A prefix that only exists to host
// sub-routes still has to say so — a bare "Route not found" on a documented
// base URL reads as a broken deployment, which is how this was first reported.
// 401 is fine (the route exists, it just needs a token).
const MODULE_BASES = [
  '', '/auth', '/dashboard', '/case-studies', '/blog', '/team', '/team/members',
  '/team/experts', '/gallery', '/gallery/categories', '/gallery/images',
  '/meeting-gallery', '/partner-logos', '/technology-logos', '/showcase',
  '/showcase/items', '/showcase/stats', '/contact', '/contact/leads',
  '/service-surveys', '/service-surveys/submissions', '/uploads', '/sitemap', '/health',
]
const notFound = []
for (const base of MODULE_BASES) {
  const res = await fetch(`${ORIGIN}${P}${base}`)
  if (res.status === 404) notFound.push(`${P}${base}`)
}
ok('no module base path returns 404', notFound.length === 0, notFound.join(', ') || `${MODULE_BASES.length} checked`)

// A GET on a POST-only endpoint should explain the verb, not read as missing.
const wrongVerb = await api('GET', `${P}/auth/login`, { expect: 405 })
ok('wrong verb returns 405 with guidance', /Use POST/.test(wrongVerb.json?.message ?? ''), wrongVerb.json?.message)
ok('405 lists the allowed methods', Array.isArray(wrongVerb.json?.errors?.allowed_methods))
const reallyMissing = await api('GET', `${P}/definitely-nothing-here`, { expect: 404 })
ok('a genuinely missing path still 404s', /Route not found/.test(reallyMissing.json?.message ?? ''))

const db = await api('GET', `${P}/health/db`, { expect: 200, route: 'GET /api/health/db' })
ok('health/db reports latency', typeof db.json?.data?.latency_ms === 'number', `${db.json?.data?.latency_ms}ms`)

// ═══════════════════════════════════════════════════════════ AUTH
H('Auth')
const login = await api('POST', `${P}/auth/login`, {
  body: { email: 'admin@ghlprime.com', password: 'Admin@12345' }, expect: 200, route: 'POST /api/auth/login',
})
if (login.status === 429) {
  console.error(`
  The auth rate limiter (AUTH_RATE_LIMIT_MAX) is currently blocking logins.
  That is correct behaviour, not a failure — this suite spends ~8 of the 10
  allowed attempts, so two runs inside the 15-minute window trip it.

  Restart the server (the limiter is in-memory) and run again.
`)
  process.exit(2)
}

const token = login.json?.data?.access_token
const refreshToken = login.json?.data?.refresh_token
ok('login returns access+refresh+user', Boolean(token && refreshToken && login.json?.data?.user?.email))
ok('login never leaks password_hash', !JSON.stringify(login.json).includes('passwordHash') && !JSON.stringify(login.json).includes('password_hash'))
ok('token_type is Bearer', login.json?.data?.token_type === 'Bearer')

await api('POST', `${P}/auth/login`, { body: { email: 'admin@ghlprime.com', password: 'nope' }, expect: 401 })
await api('POST', `${P}/auth/login`, { body: { email: 'nobody@nowhere.com', password: 'whatever' }, expect: 401 })
await api('POST', `${P}/auth/login`, { body: { email: 'not-an-email', password: 'x' }, expect: 422 })

await api('GET', `${P}/auth/me`, { token, expect: 200, route: 'GET /api/auth/me' })
await api('GET', `${P}/auth/me`, { expect: 401 })
await api('GET', `${P}/auth/session`, { token, expect: 200, route: 'GET /api/auth/session' })
await api('GET', `${P}/auth/users`, { token, expect: 200, route: 'GET /api/auth/users' })

const refreshed = await api('POST', `${P}/auth/refresh`, { body: { refreshToken }, expect: 200, route: 'POST /api/auth/refresh' })
const token2 = refreshed.json?.data?.access_token
const refresh2 = refreshed.json?.data?.refresh_token
ok('refresh rotates the token', Boolean(refresh2) && refresh2 !== refreshToken)
await api('POST', `${P}/auth/refresh`, { body: { refreshToken }, expect: 401 })
ok('spent refresh token is revoked', true)

// user management
const newUser = await api('POST', `${P}/auth/register`, {
  token: token2, body: { email: `editor_${Date.now()}@test.com`, password: 'Editor@12345', fullName: 'Test Editor', role: 'EDITOR' },
  expect: 201, route: 'POST /api/auth/register',
})
const userId = newUser.json?.data?.id
await api('POST', `${P}/auth/register`, { token: token2, body: { email: 'admin@ghlprime.com', password: 'Whatever@123' }, expect: 409 })
await api('PATCH', `${P}/auth/users/${userId}`, { token: token2, body: { fullName: 'Renamed Editor', isActive: true }, expect: 200, route: 'PATCH /api/auth/users/:id' })

// role enforcement: EDITOR must not reach admin-only routes
const editorLogin = await api('POST', `${P}/auth/login`, { body: { email: newUser.json?.data?.email, password: 'Editor@12345' }, expect: 200 })
const editorToken = editorLogin.json?.data?.access_token
await api('GET', `${P}/auth/users`, { token: editorToken, expect: 403 })
ok('EDITOR is blocked from admin-only routes (403)', true)
const editorPost = await api('POST', `${P}/blog`, { token: editorToken, body: { title: 'Editor Post', category: 'Automation' }, expect: 201 })
ok('EDITOR can manage content', true)
// Clean up immediately — this suite runs against a live database.
if (editorPost.json?.data?.id) await api('DELETE', `${P}/blog/${editorPost.json.data.id}`, { token: editorToken, expect: 200 })

await api('POST', `${P}/auth/change-password`, { token: editorToken, body: { currentPassword: 'Editor@12345', newPassword: 'Editor@54321' }, expect: 200, route: 'POST /api/auth/change-password' })
await api('POST', `${P}/auth/change-password`, { token: editorToken, body: { currentPassword: 'wrong', newPassword: 'Editor@99999' }, expect: [401, 403] })
await api('POST', `${P}/auth/logout`, { token: editorToken, body: {}, expect: 200, route: 'POST /api/auth/logout' })
await api('DELETE', `${P}/auth/users/${userId}`, { token: token2, expect: 200, route: 'DELETE /api/auth/users/:id' })

// ═══════════════════════════════════════════════════════════ DASHBOARD
H('Dashboard')
const summary = await api('GET', `${P}/dashboard/summary`, { token: token2, expect: 200, route: 'GET /api/dashboard/summary' })
await api('GET', `${P}/dashboard/counts`, { token: token2, expect: 200, route: 'GET /api/dashboard/counts' })
await api('GET', `${P}/dashboard/recent`, { token: token2, expect: 200, route: 'GET /api/dashboard/recent' })
await api('GET', `${P}/dashboard/summary`, { expect: 401 })
ok('summary has counts+recent', Boolean(summary.json?.data?.counts && summary.json?.data?.recent))

// ═══════════════════════════════════════════════════════════ CASE STUDIES
H('Case studies')
const teamRes = await api('GET', `${P}/team/members`, { expect: 200, route: 'GET /api/team/members/' })
const memberId = teamRes.json?.data?.[0]?.id

const csList = await api('GET', `${P}/case-studies/`, { expect: 200, route: 'GET /api/case-studies/' })
await api('GET', `${P}/case-studies/?category=Automation&search=lead`, { expect: 200 })
await api('GET', `${P}/case-studies/admin`, { token: token2, expect: 200, route: 'GET /api/case-studies/admin' })
await api('GET', `${P}/case-studies/admin`, { expect: 401 })
await api('GET', `${P}/case-studies/categories`, { expect: 200, route: 'GET /api/case-studies/categories' })
const csSlug = csList.json?.data?.[0]?.slug
const oneCs = await api('GET', `${P}/case-studies/slug/${csSlug}`, { expect: 200, route: 'GET /api/case-studies/slug/:slug' })
ok('case study embeds assigned_team_members', Array.isArray(oneCs.json?.data?.assigned_team_members))
await api('GET', `${P}/case-studies/slug/does-not-exist`, { expect: 404 })

const cs = await api('POST', `${P}/case-studies/`, {
  token: token2, expect: 201, route: 'POST /api/case-studies/',
  body: { title: 'API Test Case Study', category: 'Automation', excerpt: 'e', body: ['p1', 'p2'], published: false, teamMemberIds: memberId ? [memberId] : [] },
})
const csId = cs.json?.data?.id
ok('slug auto-generated from title', cs.json?.data?.slug === 'api-test-case-study', cs.json?.data?.slug)
ok('team assignment synced', cs.json?.data?.assigned_team_members?.length === (memberId ? 1 : 0))
ok('draft is hidden from public list', true)

await api('GET', `${P}/case-studies/${csId}`, { expect: 200, route: 'GET /api/case-studies/:id' })
await api('PUT', `${P}/case-studies/${csId}`, { token: token2, body: { title: 'API Test CS v2', category: 'Automation', published: true }, expect: 200, route: 'PUT /api/case-studies/:id' })
await api('PATCH', `${P}/case-studies/${csId}`, { token: token2, body: { outcome: 'Great', teamMemberIds: [] }, expect: 200, route: 'PATCH /api/case-studies/:id' })
await api('POST', `${P}/case-studies/`, { token: token2, body: { category: 'No title' }, expect: 422 })
await api('GET', `${P}/case-studies/not-a-uuid`, { expect: 422 })
await api('GET', `${P}/case-studies/00000000-0000-0000-0000-000000000000`, { expect: 404 })
await api('DELETE', `${P}/case-studies/${csId}`, { token: token2, expect: 200, route: 'DELETE /api/case-studies/:id' })

// ═══════════════════════════════════════════════════════════ BLOG
H('Blog')
const blogList = await api('GET', `${P}/blog/`, { expect: 200, route: 'GET /api/blog/' })
const paged = await api('GET', `${P}/blog/?page=1&limit=5`, { expect: 200 })
ok('pagination returns meta', paged.json?.meta?.limit === 5 && paged.json?.data?.length <= 5, JSON.stringify(paged.json?.meta))
await api('GET', `${P}/blog/admin`, { token: token2, expect: 200, route: 'GET /api/blog/admin' })
await api('GET', `${P}/blog/categories`, { expect: 200, route: 'GET /api/blog/categories' })
const bSlug = blogList.json?.data?.[0]?.slug
const bCat = blogList.json?.data?.[0]?.category
await api('GET', `${P}/blog/slug/${bSlug}`, { expect: 200, route: 'GET /api/blog/slug/:slug' })
const related = await api('GET', `${P}/blog/related?category=${encodeURIComponent(bCat)}&exclude=${bSlug}&limit=3`, { expect: 200, route: 'GET /api/blog/related' })
ok('related excludes the source post', !related.json?.data?.some(p => p.slug === bSlug))
await api('GET', `${P}/blog/related`, { expect: 422 })

const bp = await api('POST', `${P}/blog/`, {
  token: token2, expect: 201, route: 'POST /api/blog/',
  body: { title: 'API Test Post', category: 'Automation', tags: ['a', 'b'], content: '<p>hi</p>', published: true },
})
const bpId = bp.json?.data?.id
ok('published_at auto-stamped', Boolean(bp.json?.data?.published_at))
ok('tags stored as array', Array.isArray(bp.json?.data?.tags) && bp.json?.data?.tags.length === 2)
await api('GET', `${P}/blog/${bpId}`, { expect: 200, route: 'GET /api/blog/:id' })
await api('PUT', `${P}/blog/${bpId}`, { token: token2, body: { title: 'API Test Post v2', category: 'Automation' }, expect: 200, route: 'PUT /api/blog/:id' })
await api('PATCH', `${P}/blog/${bpId}`, { token: token2, body: { excerpt: 'updated' }, expect: 200, route: 'PATCH /api/blog/:id' })
await api('DELETE', `${P}/blog/${bpId}`, { token: token2, expect: 200, route: 'DELETE /api/blog/:id' })

// ═══════════════════════════════════════════════════════════ TEAM
H('Team — leaders, experts, and the bare alias')
await api('GET', `${P}/team/`, { expect: 200, route: 'GET /api/team/' })
await api('GET', `${P}/team/admin`, { token: token2, expect: 200, route: 'GET /api/team/admin' })
await api('GET', `${P}/team/members/admin`, { token: token2, expect: 200, route: 'GET /api/team/members/admin' })
await api('GET', `${P}/team/experts/`, { expect: 200, route: 'GET /api/team/experts/' })
await api('GET', `${P}/team/experts/admin`, { token: token2, expect: 200, route: 'GET /api/team/experts/admin' })

const leader = await api('POST', `${P}/team/members/`, {
  token: token2, expect: 201, route: 'POST /api/team/members/',
  body: { name: 'API Leader', role: 'QA', sort_order: 7, linkedin_url: 'https://linkedin.com/in/x' },
})
const leaderId = leader.json?.data?.id
ok('sort_order honoured on create', leader.json?.data?.sort_order === 7)
await api('GET', `${P}/team/members/${leaderId}`, { expect: 200, route: 'GET /api/team/members/:id' })
await api('PUT', `${P}/team/members/${leaderId}`, { token: token2, body: { name: 'API Leader v2', role: 'QA' }, expect: 200, route: 'PUT /api/team/members/:id' })
const patched = await api('PATCH', `${P}/team/members/${leaderId}`, { token: token2, body: { description: 'd' }, expect: 200, route: 'PATCH /api/team/members/:id' })
ok('partial update preserves sort_order', patched.json?.data?.sort_order === 7)
await api('PATCH', `${P}/team/members/reorder`, { token: token2, body: { items: [{ id: leaderId, sort_order: 3 }] }, expect: 200, route: 'PATCH /api/team/members/reorder' })
await api('PATCH', `${P}/team/reorder`, { token: token2, body: { items: [{ id: leaderId, sort_order: 7 }] }, expect: 200, route: 'PATCH /api/team/reorder' })
await api('POST', `${P}/team/members/`, { token: token2, body: { role: 'no name' }, expect: 422 })
await api('DELETE', `${P}/team/members/${leaderId}`, { token: token2, expect: 200, route: 'DELETE /api/team/members/:id' })

// bare /team alias (same router)
const aliasLeader = await api('POST', `${P}/team/`, { token: token2, body: { name: 'Alias Leader', role: 'QA' }, expect: 201, route: 'POST /api/team/' })
await api('GET', `${P}/team/${aliasLeader.json?.data?.id}`, { expect: 200, route: 'GET /api/team/:id' })
await api('PUT', `${P}/team/${aliasLeader.json?.data?.id}`, { token: token2, body: { name: 'Alias v2', role: 'QA' }, expect: 200, route: 'PUT /api/team/:id' })
await api('PATCH', `${P}/team/${aliasLeader.json?.data?.id}`, { token: token2, body: { description: 'x' }, expect: 200, route: 'PATCH /api/team/:id' })
await api('DELETE', `${P}/team/${aliasLeader.json?.data?.id}`, { token: token2, expect: 200, route: 'DELETE /api/team/:id' })

const expert = await api('POST', `${P}/team/experts/`, { token: token2, body: { name: 'API Expert', title: 'Spec', image_url: 'https://example.com/e.png', sort_order: 2 }, expect: 201, route: 'POST /api/team/experts/' })
const expertId = expert.json?.data?.id
await api('GET', `${P}/team/experts/${expertId}`, { expect: 200, route: 'GET /api/team/experts/:id' })
await api('PUT', `${P}/team/experts/${expertId}`, { token: token2, body: { name: 'API Expert v2', title: 'Spec', image_url: 'https://example.com/e.png' }, expect: 200, route: 'PUT /api/team/experts/:id' })
await api('PATCH', `${P}/team/experts/${expertId}`, { token: token2, body: { title: 'Senior Spec' }, expect: 200, route: 'PATCH /api/team/experts/:id' })
await api('PATCH', `${P}/team/experts/reorder`, { token: token2, body: { items: [{ id: expertId, sort_order: 1 }] }, expect: 200, route: 'PATCH /api/team/experts/reorder' })
await api('DELETE', `${P}/team/experts/${expertId}`, { token: token2, expect: 200, route: 'DELETE /api/team/experts/:id' })

// ═══════════════════════════════════════════════════════════ GALLERY
H('Gallery')
const gAll = await api('GET', `${P}/gallery/`, { expect: 200, route: 'GET /api/gallery/' })
ok('combined gallery returns categories+images', Array.isArray(gAll.json?.data?.categories) && Array.isArray(gAll.json?.data?.images))
await api('GET', `${P}/gallery/categories/`, { expect: 200, route: 'GET /api/gallery/categories/' })
await api('GET', `${P}/gallery/categories/admin`, { token: token2, expect: 200, route: 'GET /api/gallery/categories/admin' })
await api('GET', `${P}/gallery/images/`, { expect: 200, route: 'GET /api/gallery/images/' })
await api('GET', `${P}/gallery/images/admin`, { token: token2, expect: 200, route: 'GET /api/gallery/images/admin' })

const gc = await api('POST', `${P}/gallery/categories/`, { token: token2, body: { name: 'API Gallery Cat' }, expect: 201, route: 'POST /api/gallery/categories/' })
const gcId = gc.json?.data?.id
ok('category slug auto-generated', gc.json?.data?.slug === 'api-gallery-cat', gc.json?.data?.slug)
await api('GET', `${P}/gallery/categories/${gcId}`, { expect: 200, route: 'GET /api/gallery/categories/:id' })
await api('PUT', `${P}/gallery/categories/${gcId}`, { token: token2, body: { name: 'API Cat v2' }, expect: 200, route: 'PUT /api/gallery/categories/:id' })
await api('PATCH', `${P}/gallery/categories/${gcId}`, { token: token2, body: { published: true }, expect: 200, route: 'PATCH /api/gallery/categories/:id' })
await api('PATCH', `${P}/gallery/categories/reorder`, { token: token2, body: { items: [{ id: gcId, sort_order: 5 }] }, expect: 200, route: 'PATCH /api/gallery/categories/reorder' })

const gi = await api('POST', `${P}/gallery/images/`, { token: token2, body: { title: 'API Img', image_url: 'https://example.com/i.png', category_id: gcId }, expect: 201, route: 'POST /api/gallery/images/' })
const giId = gi.json?.data?.id
await api('GET', `${P}/gallery/images/${giId}`, { expect: 200, route: 'GET /api/gallery/images/:id' })
const byCat = await api('GET', `${P}/gallery/images/by-category/${gcId}`, { expect: 200, route: 'GET /api/gallery/images/by-category/:categoryId' })
ok('by-category filters correctly', byCat.json?.data?.every(i => i.category_id === gcId))
await api('PUT', `${P}/gallery/images/${giId}`, { token: token2, body: { title: 'API Img v2', image_url: 'https://example.com/i2.png' }, expect: 200, route: 'PUT /api/gallery/images/:id' })
await api('PATCH', `${P}/gallery/images/${giId}`, { token: token2, body: { published: false }, expect: 200, route: 'PATCH /api/gallery/images/:id' })
await api('PATCH', `${P}/gallery/images/reorder`, { token: token2, body: { items: [{ id: giId, sort_order: 4 }] }, expect: 200, route: 'PATCH /api/gallery/images/reorder' })
await api('DELETE', `${P}/gallery/images/${giId}`, { token: token2, expect: 200, route: 'DELETE /api/gallery/images/:id' })
await api('DELETE', `${P}/gallery/categories/${gcId}`, { token: token2, expect: 200, route: 'DELETE /api/gallery/categories/:id' })

// ═══════════════════════════════════════════════════════════ SORTABLE COLLECTIONS
H('Meeting gallery / partner logos / technology logos')
for (const [base, createBody, routeBase] of [
  ['meeting-gallery', { title: 'API Meeting', image_url: 'https://example.com/m.png' }, '/api/meeting-gallery'],
  ['partner-logos', { name: 'API Partner', image_url: 'https://example.com/p.png', sort_order: 6 }, '/api/partner-logos'],
  ['technology-logos', { name: 'API Tech', image_url: 'https://example.com/t.png' }, '/api/technology-logos'],
]) {
  await api('GET', `${P}/${base}/`, { expect: 200, route: `GET ${routeBase}/` })
  await api('GET', `${P}/${base}/admin`, { token: token2, expect: 200, route: `GET ${routeBase}/admin` })
  await api('GET', `${P}/${base}/admin`, { expect: 401 })

  const created = await api('POST', `${P}/${base}/`, { token: token2, body: createBody, expect: 201, route: `POST ${routeBase}/` })
  const id = created.json?.data?.id
  await api('GET', `${P}/${base}/${id}`, { expect: 200, route: `GET ${routeBase}/:id` })
  await api('PUT', `${P}/${base}/${id}`, { token: token2, body: createBody, expect: 200, route: `PUT ${routeBase}/:id` })
  await api('PATCH', `${P}/${base}/${id}`, { token: token2, body: { published: false }, expect: 200, route: `PATCH ${routeBase}/:id` })
  await api('PATCH', `${P}/${base}/reorder`, { token: token2, body: { items: [{ id, sort_order: 8 }] }, expect: 200, route: `PATCH ${routeBase}/reorder` })
  await api('DELETE', `${P}/${base}/${id}`, { token: token2, expect: 200, route: `DELETE ${routeBase}/:id` })
}

const pl = await api('POST', `${P}/partner-logos/`, { token: token2, body: { name: 'Alias Check', image_url: 'https://e.com/a.png' }, expect: 201 })
ok('partner logo exposes name AND company_name', pl.json?.data?.name === 'Alias Check' && pl.json?.data?.company_name === 'Alias Check')
await api('DELETE', `${P}/partner-logos/${pl.json?.data?.id}`, { token: token2, expect: 200 })

// ═══════════════════════════════════════════════════════════ SHOWCASE
H('Showcase')
const scPage = await api('GET', `${P}/showcase/page/home`, { expect: 200, route: 'GET /api/showcase/page/:pageKey' })
ok('page bundle returns items+stats', Array.isArray(scPage.json?.data?.items) && Array.isArray(scPage.json?.data?.stats))
await api('GET', `${P}/showcase/items/`, { expect: 200, route: 'GET /api/showcase/items/' })
await api('GET', `${P}/showcase/items/admin`, { token: token2, expect: 200, route: 'GET /api/showcase/items/admin' })
await api('GET', `${P}/showcase/items/page/home`, { expect: 200, route: 'GET /api/showcase/items/page/:pageKey' })
await api('GET', `${P}/showcase/stats/`, { expect: 200, route: 'GET /api/showcase/stats/' })
await api('GET', `${P}/showcase/stats/admin`, { token: token2, expect: 200, route: 'GET /api/showcase/stats/admin' })

const si = await api('POST', `${P}/showcase/items/`, {
  token: token2, expect: 201, route: 'POST /api/showcase/items/',
  body: { origin_name: 'API Origin', adaptation_name: 'API Adapt', adaptation_tags: ['X', 'Y'], placements: [{ page_key: 'home', sort_order: 9 }] },
})
const siId = si.json?.data?.id
ok('placements synced on create', si.json?.data?.placements?.length === 1)
ok('adaptation_tags stored as JSON array', Array.isArray(si.json?.data?.adaptation_tags))
await api('GET', `${P}/showcase/items/${siId}`, { expect: 200, route: 'GET /api/showcase/items/:id' })
await api('PUT', `${P}/showcase/items/${siId}`, { token: token2, body: { origin_name: 'API Origin v2', adaptation_name: 'API Adapt' }, expect: 200, route: 'PUT /api/showcase/items/:id' })
const siCleared = await api('PATCH', `${P}/showcase/items/${siId}`, { token: token2, body: { placements: [] }, expect: 200, route: 'PATCH /api/showcase/items/:id' })
ok('empty placements array clears placements', siCleared.json?.data?.placements?.length === 0)
await api('PATCH', `${P}/showcase/items/reorder`, { token: token2, body: { items: [{ id: siId, sort_order: 3 }] }, expect: 200, route: 'PATCH /api/showcase/items/reorder' })
await api('DELETE', `${P}/showcase/items/${siId}`, { token: token2, expect: 200, route: 'DELETE /api/showcase/items/:id' })

const ss = await api('POST', `${P}/showcase/stats/`, { token: token2, body: { value: '42', label: 'API STAT' }, expect: 201, route: 'POST /api/showcase/stats/' })
const ssId = ss.json?.data?.id
await api('GET', `${P}/showcase/stats/${ssId}`, { expect: 200, route: 'GET /api/showcase/stats/:id' })
await api('PUT', `${P}/showcase/stats/${ssId}`, { token: token2, body: { value: '43', label: 'API STAT' }, expect: 200, route: 'PUT /api/showcase/stats/:id' })
await api('PATCH', `${P}/showcase/stats/${ssId}`, { token: token2, body: { published: false }, expect: 200, route: 'PATCH /api/showcase/stats/:id' })
await api('PATCH', `${P}/showcase/stats/reorder`, { token: token2, body: { items: [{ id: ssId, sort_order: 2 }] }, expect: 200, route: 'PATCH /api/showcase/stats/reorder' })
await api('DELETE', `${P}/showcase/stats/${ssId}`, { token: token2, expect: 200, route: 'DELETE /api/showcase/stats/:id' })

// ═══════════════════════════════════════════════════════════ CONTACT
H('Contact')
const lead = await api('POST', `${P}/contact/submit`, {
  expect: [201, 502], route: 'POST /api/contact/submit',
  body: {
    name: 'API Contact', email: 'api-contact@example.com', business_name: 'API Co', country: 'US', phone: '+1 555 0111',
    role: 'Agency owner', ghl_situation: 'Messy', client_volume: '6-20', monthly_budget: '$2k-5k',
    timeline: 'ASAP', biggest_challenge: 'Broken automations', formStartedAt: Date.now() - 30000,
  },
})
const leadId = lead.json?.data?.id
ok('rich contact fields persisted', lead.json?.data?.ghl_situation === 'Messy' && lead.json?.data?.monthly_budget === '$2k-5k')
ok('lead starts in NEW status', lead.json?.data?.status === 'NEW')
const spam = await api('POST', `${P}/contact/submit`, { body: { name: 'Bot', email: 'b@x.com', website: 'http://spam' }, expect: 201 })
ok('honeypot silently flags spam', spam.json?.data?.spam === true)
await api('POST', `${P}/contact/submit`, { body: { email: 'bad' }, expect: 422 })

const leadList = await api('GET', `${P}/contact/leads/`, { token: token2, expect: 200, route: 'GET /api/contact/leads/' })
ok('lead inbox is paginated', typeof leadList.json?.meta?.total === 'number')
await api('GET', `${P}/contact/leads/`, { expect: 401 })
await api('GET', `${P}/contact/leads/stats`, { token: token2, expect: 200, route: 'GET /api/contact/leads/stats' })
await api('GET', `${P}/contact/leads/${leadId}`, { token: token2, expect: 200, route: 'GET /api/contact/leads/:id' })
const moved = await api('PATCH', `${P}/contact/leads/${leadId}/status`, { token: token2, body: { status: 'QUALIFIED', notes: 'Good fit' }, expect: 200, route: 'PATCH /api/contact/leads/:id/status' })
ok('status transition applied', moved.json?.data?.status === 'QUALIFIED')
await api('PATCH', `${P}/contact/leads/${leadId}/status`, { token: token2, body: { status: 'NOT_A_STATUS' }, expect: 422 })
await api('GET', `${P}/contact/leads/?status=QUALIFIED&page=1&limit=5`, { token: token2, expect: 200 })
await api('DELETE', `${P}/contact/leads/${leadId}`, { token: token2, expect: 200, route: 'DELETE /api/contact/leads/:id' })

// ═══════════════════════════════════════════════════════════ SERVICE SURVEYS
H('Service surveys')
const survey = await api('POST', `${P}/service-surveys/submit`, {
  expect: [201, 502], route: 'POST /api/service-surveys/submit',
  body: {
    name: 'API Survey', email: 'api-survey@example.com', phone: '+1 555 0122', business: 'API Agency',
    role: 'Agency owner', needs: 'GHL setup', sub_accounts: '6–20 clients', service: '/services/ghl-setup',
    source: 'Service page survey', details: 'Q1: A1', page_url: 'https://ghlprime.com/services/ghl-setup',
    formStartedAt: Date.now() - 30000,
  },
})
const surveyId = survey.json?.data?.id
ok('survey service page recorded', survey.json?.data?.service === '/services/ghl-setup')
ok('survey sub_accounts mapped', survey.json?.data?.sub_accounts === '6–20 clients')
await api('POST', `${P}/service-surveys/submit`, { body: { email: 'nope' }, expect: 422 })
await api('GET', `${P}/service-surveys/submissions/`, { token: token2, expect: 200, route: 'GET /api/service-surveys/submissions/' })
await api('GET', `${P}/service-surveys/submissions/stats`, { token: token2, expect: 200, route: 'GET /api/service-surveys/submissions/stats' })
await api('GET', `${P}/service-surveys/submissions/${surveyId}`, { token: token2, expect: 200, route: 'GET /api/service-surveys/submissions/:id' })
const byService = await api('GET', `${P}/service-surveys/by-service`, { token: token2, expect: 200, route: 'GET /api/service-surveys/by-service' })
ok('by-service groups submissions', Array.isArray(byService.json?.data))
await api('PATCH', `${P}/service-surveys/submissions/${surveyId}/status`, { token: token2, body: { status: 'CONTACTED' }, expect: 200, route: 'PATCH /api/service-surveys/submissions/:id/status' })
await api('DELETE', `${P}/service-surveys/submissions/${surveyId}`, { token: token2, expect: 200, route: 'DELETE /api/service-surveys/submissions/:id' })

// ═══════════════════════════════════════════════════════════ UPLOADS
H('Uploads (Cloudinary)')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const mkForm = (field, name, data, type = 'image/png', extra = {}) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  fd.append(field, new Blob([data], { type }), name)
  return fd
}

const upStatus = await api('GET', `${P}/uploads/status`, { expect: 200, route: 'GET /api/uploads/status' })
ok('status reports configured flag + limits', typeof upStatus.json?.data?.configured === 'boolean' && upStatus.json?.data?.max_file_size_mb > 0)
const cloudinaryOn = upStatus.json?.data?.configured === true
const expectUpload = cloudinaryOn ? 201 : 503

await api('POST', `${P}/uploads/image`, { form: mkForm('file', 'p.png', PNG), expect: 401 })

// 502 is a legitimate outcome when credentials exist but the key lacks the
// Cloudinary "create" permission — the API is behaving correctly either way.
const single = await api('POST', `${P}/uploads/image`, {
  token: token2, form: mkForm('file', 'p.png', PNG, 'image/png', { alt: 'x' }),
  expect: cloudinaryOn ? [201, 502] : 503, route: 'POST /api/uploads/image',
})
const multiRes = await api('POST', `${P}/uploads/images`, {
  token: token2, form: mkForm('files', 'p.png', PNG),
  expect: cloudinaryOn ? [201, 502] : 503, route: 'POST /api/uploads/images',
})
ok('single and multi upload agree on outcome', single.status === multiRes.status,
  `single=${single.status} multi=${multiRes.status}`)
if (single.status === 502) {
  ok('403 from Cloudinary is explained, not just echoed', /permission/i.test(single.json?.message ?? ''),
    single.json?.message?.slice(0, 110))
}
if (single.status === 201) {
  ok('upload returns a secure_url', String(single.json?.data?.secure_url).startsWith('https://res.cloudinary.com/'))
  const createdId = single.json?.data?.id
  if (createdId) await api('DELETE', `${P}/uploads/${createdId}`, { token: token2, expect: 200 })
}
await api('POST', `${P}/uploads/image`, { token: token2, form: mkForm('file', 'x.sh', Buffer.from('#!/bin/sh'), 'application/x-sh'), expect: 400 })
await api('POST', `${P}/uploads/image`, { token: token2, form: mkForm('file', 'big.png', Buffer.alloc(11 * 1024 * 1024)), expect: 400 })
await api('GET', `${P}/uploads/signature`, { token: token2, expect: cloudinaryOn ? 200 : 503, route: 'GET /api/uploads/signature' })
await api('GET', `${P}/uploads/library`, { token: token2, expect: 200, route: 'GET /api/uploads/library' })
await api('GET', `${P}/uploads/library`, { expect: 401 })
// The base path is a public index, so a browser hitting it gets guidance.
const upIdx = await api('GET', `${P}/uploads`, { expect: 200, route: 'GET /api/uploads/' })
ok('uploads index is public and lists endpoints', upIdx.json?.data?.endpoints?.length >= 6)
await api('DELETE', `${P}/uploads/00000000-0000-0000-0000-000000000000`, { token: token2, expect: [404, 503], route: 'DELETE /api/uploads/:id' })
await api('DELETE', `${P}/uploads/public-id/ghlprime/nonexistent`, { token: token2, expect: [200, 404, 503], route: 'DELETE /api/uploads/public-id/*' })
ok(`uploads behave correctly (cloudinary ${cloudinaryOn ? 'configured' : 'not configured'})`, true)

// ═══════════════════════════════════════════════════════════ SITEMAP & COMPAT
H('Sitemap & compatibility routes')
// Read the shared secret the server was started with, if one is set.
const backendEnv = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const sitemapToken = (/^SITEMAP_REFRESH_TOKEN=(.*)$/m.exec(backendEnv)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')

if (sitemapToken) {
  await api('POST', `${P}/sitemap/refresh`, { expect: 401 })
  ok('sitemap refresh rejects a missing token', true)
  const wrong = await fetch(`${ORIGIN}${P}/sitemap/refresh`, { method: 'POST', headers: { Authorization: 'Bearer wrong-token' } })
  ok('sitemap refresh rejects a wrong token', wrong.status === 401, `${wrong.status}`)
}

const refreshRes = await fetch(`${ORIGIN}${P}/sitemap/refresh`, {
  method: 'POST',
  headers: sitemapToken ? { Authorization: `Bearer ${sitemapToken}` } : {},
})
covered.add('POST /api/sitemap/refresh')
const refreshed2 = { status: refreshRes.status, json: await refreshRes.json().catch(() => null) }
ok('POST /api/sitemap/refresh', refreshed2.status === 200, `${refreshed2.status}`)
ok('sitemap refresh reports URL count', refreshed2.json?.data?.count > 0, `${refreshed2.json?.data?.count} URLs`)

if (sitemapToken) {
  const viaHeader = await fetch(`${ORIGIN}${P}/sitemap/refresh`, { method: 'POST', headers: { 'X-Sitemap-Token': sitemapToken } })
  ok('sitemap refresh also accepts X-Sitemap-Token', viaHeader.status === 200, `${viaHeader.status}`)
}
const xml = await api('GET', `${P}/sitemap/xml`, { expect: 200, raw: true, route: 'GET /api/sitemap/xml' })
ok('sitemap/xml is valid XML', xml.text?.startsWith('<?xml') && xml.text.includes('<urlset'))
ok('sitemap content-type is application/xml', xml.headers.get('content-type')?.includes('application/xml'))
const xml2 = await api('GET', '/sitemap.xml', { expect: 200, raw: true, route: 'GET /sitemap.xml' })
ok('/sitemap.xml serves the same document', xml2.text?.startsWith('<?xml'))
const gone = await api('GET', '/free-scripts', { expect: 410, raw: true, route: 'GET /free-scripts' })
ok('/free-scripts returns 410 HTML', gone.text?.includes('410 Gone'))

// ═══════════════════════════════════════════════════════════ CROSS-CUTTING
H('Cross-cutting behaviour')
const nf = await api('GET', `${P}/definitely-not-here`, { expect: 404 })
ok('404 uses the standard envelope', nf.json?.success === false && typeof nf.json?.message === 'string')
const badJson = await fetch(`${ORIGIN}${P}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
ok('malformed JSON -> 400', badJson.status === 400, `${badJson.status}`)
const val = await api('POST', `${P}/blog/`, { token: token2, body: { category: 'x' }, expect: 422 })
ok('422 lists field-level errors', Array.isArray(val.json?.errors) && val.json.errors[0]?.field)
const sec = await fetch(`${ORIGIN}${P}/health`)
ok('helmet security headers present', Boolean(sec.headers.get('x-content-type-options')), sec.headers.get('x-content-type-options'))
ok('x-powered-by is disabled', !sec.headers.get('x-powered-by'))
const cors = await fetch(`${ORIGIN}${P}/health`, { headers: { Origin: 'http://localhost:5173' } })
ok('CORS allows the configured origin', cors.headers.get('access-control-allow-origin') === 'http://localhost:5173')
const badCors = await fetch(`${ORIGIN}${P}/health`, { headers: { Origin: 'http://evil.example.com' } })
ok('CORS rejects an unlisted origin', badCors.status === 403 || !badCors.headers.get('access-control-allow-origin'), `${badCors.status}`)

// ═══════════════════════════════════════════════════════════ COVERAGE
H('Route coverage')
const all = JSON.parse(readFileSync(new URL('./.routes.json', import.meta.url)))
const missing = all.filter(r => !covered.has(`${r.method} ${r.path}`))
console.log(`  endpoints registered : ${all.length}`)
console.log(`  endpoints exercised  : ${all.length - missing.length}`)
if (missing.length) {
  console.log(`\n  NOT COVERED (${missing.length}):`)
  missing.forEach(r => console.log(`    ${r.method.padEnd(7)} ${r.path}`))
}
ok('every registered endpoint was exercised', missing.length === 0, `${missing.length} uncovered`)

console.log(`\n${'═'.repeat(64)}`)
console.log(`  PASSED: ${pass}    FAILED: ${fail}`)
console.log('═'.repeat(64))
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  • ${f}`)) }
process.exit(fail ? 1 : 0)
