# Write one Blog Writer post

You were spawned unattended by `scripts/blog-watch.ts` to write ONE blog
post for a specific request. There is no human watching this session —
never pause to ask a question or wait for confirmation. If something is
genuinely wrong (the topic makes no sense, research turns up nothing
usable), call `fail` (step 6) and stop. Do not guess your way past a real
problem.

Your request ID is the one given to you in the prompt that started this
session. Every command below runs from the repo root via `npx tsx`.

## 1. Read the writing standard

```
npm run blog:rules
```

This prints the current tone, structure, SEO, and sourcing rules — written
by an admin and reflecting live settings, not something to skip because it
looks familiar from a previous run.

## 2. Get the request

```
npx tsx scripts/blog-queue.ts phase <request_id> reading_standard
npx tsx scripts/blog-queue.ts get <request_id>
```

The second command prints `{ request, topic }` as JSON. Your subject is
`topic.title` (or `request.ad_hoc_title` if there's no linked topic) and, if
present, `topic.target_keyword` and `topic.category`. `topic.research_mode`
is either:

- `"keyword"` — write directly from the title/keyword.
- `"sources"` — research real, current headlines/articles on this subject
  first and ground the post in what they actually say, rather than writing
  from the keyword alone.

## 3. Research

```
npx tsx scripts/blog-queue.ts phase <request_id> researching
```

Use WebSearch/WebFetch to gather real, current material — GHL Prime's own
services and positioning (this is a GoHighLevel automation agency's blog),
plus whatever the topic needs. Note real source URLs as you go; you'll need
them for the `sources` field in step 4.

If research turns up nothing substantive to write about (the "topic has
nothing worth writing" case from the spec), skip straight to step 6 with
`fail` rather than writing a thin, padded post.

## 4. Write

```
npx tsx scripts/blog-queue.ts phase <request_id> writing
```

Write the full post and save it as JSON to a temp file (e.g.
`/tmp/blog-draft-<request_id>.json` or your working directory — anywhere
you can pass the path to the next two steps). Shape:

```json
{
  "title": "string, required",
  "slug": "optional — derived from title if omitted",
  "category": "one of the categories blog:rules printed",
  "tags": ["string", "..."],
  "excerpt": "1-2 sentence summary",
  "content": "the full post body — HTML or markdown, matching what existing posts in this codebase use",
  "seo_title": "<= 60 chars",
  "seo_description": "<= 155 chars",
  "seo_keywords": "comma-separated",
  "target_keyword": "from the topic, if it had one",
  "cta_variant": "your choice of CTA framing for this post's angle",
  "sources": [{ "url": "...", "name": "..." }],
  "research_mode": "keyword | sources, matching the topic",
  "source_url": "for research_mode=sources: the single strongest source",
  "source_name": "that source's publication/site name"
}
```

Follow every rule `blog:rules` printed — style, structure, SEO limits,
banned phrases, sourcing. This is graded in the next step, not a suggestion.

## 5. Audit

```
npx tsx scripts/blog-queue.ts phase <request_id> auditing
npx tsx scripts/blog-audit.ts /path/to/your-draft.json
```

Prints `{ passed, score, issues }`. If `passed` is `false`, read `issues`
and fix the draft, then re-run the audit. Don't loop on this more than two
or three times — if it still won't pass, save it anyway (step 7 always
saves; `passed` only controls whether it can auto-publish) and let a human
review it as a draft.

## 6. Cover image

```
npx tsx scripts/blog-queue.ts phase <request_id> images
npx tsx scripts/blog-import.ts "<a short image search query for this topic>"
```

Prints `{ "cover_image": "url or null" }`. Add that URL into your draft
JSON's `cover_image` field (or leave it unset if null — a missing cover
image is fine, never a reason to fail the run).

## 7. Save

```
npx tsx scripts/blog-queue.ts phase <request_id> saving
npx tsx scripts/blog-queue.ts save <request_id> /path/to/your-draft.json <true|false from the audit's "passed">
```

This creates the post. Whether it actually publishes (vs. saves as a draft
for human review) is decided by `save` itself from the admin's
auto-publish setting AND your audit result together — not something you
control directly. You're done once this prints `{ "ok": true, ... }`.

## If something goes wrong

```
npx tsx scripts/blog-queue.ts fail <request_id> "<short reason>"
```

Call this and stop for: nothing worth writing on this topic, a research
dead-end, or any error you can't work around. Do not leave the request
without calling either `save` or `fail` — an unfinished request is what
`blog-watch.ts` retries or eventually fails on your behalf, which is a
worse outcome than reporting the real reason yourself.
