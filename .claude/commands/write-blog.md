---
description: Write blog drafts from the dashboard queue and import them into the blog
---

# Write blog posts

Write one or more blog posts to the standard this repo defines, save them as
JSON drafts, and import them into the database.

Arguments (`$ARGUMENTS`), all optional:
- `id:<queue id>` — writes that one queued topic. This is the form the watcher
  sends for an unattended run: an id is a plain uuid, so nothing an editor can
  type into the dashboard reaches a command line.
- A topic in quotes, or a pasted URL — writes just that one, ignoring the queue.
- A number — writes that many from the top of the queue.
- Nothing — uses the `posts per run` count from the queue.

Never write more than 3 in one invocation without the user explicitly asking for
more. Each post is a real piece of work, and a batch of five written quickly is
five mediocre posts. If the count is above 3, write 3 and say why.

This session is unattended when started by the watcher. Never pause to ask a
question or wait for confirmation. If something is genuinely wrong (the topic
makes no sense, research turns up nothing usable), say so plainly — the words
"nothing worth writing" in your final message are what the watcher reads — and
stop. Do not guess your way past a real problem.

## Step 1 — Load the standard

Run this before writing anything:

```
npm run blog:rules
```

It prints the actual rules this site's prose is held to, and they are long for
good reason: `KEYWORD_BLOG_SYSTEM_PROMPT` (grounding, structure, banned
constructions, output rules), `MODE_RULES` (the three framings), `INVARIANTS`
plus `REWRITE_SYSTEM_PROMPT` (the prose-quality pass), and the two research
gates (`SOURCE_QUALITY_SYSTEM_PROMPT`, `STORY_PICKER_SYSTEM_PROMPT`).

Do not summarize them from memory or from a previous session. Run the command.
They are the source of truth and they change. Do not open
`src/modules/blog-writer/lib/writing-standard.ts` to read them instead — the
command prints the same text, without the TypeScript around it.

## Step 2 — Pick the topic

Run `npm run blog:queue` (add `-- --json` if you prefer parsing it). It prints
the queue and the settings each topic will run with:

```
posts per run: 1
default images: 1
default words: 500
default cta: general
auto-publish: off
categories (pick exactly one per post): GoHighLevel, Automation, AI Agents, Case Studies, Voice AI, CRM, Vibe Coding

1. [keyword] gohighlevel a2p 10dlc registration
   images: 1 | words: 500 | cta: general | id: 6a8d2ecc-3a60-402c-9d5d-78be3f1a2b3c
   notes: ...

internal links — our own pages, the ONLY ones a post may link to.
Copy a path exactly as written. Never guess one that is not here.

   /services/ghl-setup  —  GHL Setup & Configuration
   /blog/some-earlier-post  —  Some Earlier Post
   ...
```

The queue lives in the database and is edited from the dashboard at
`/admin/blog-writer`.

**`posts per run`** is how many to write this run, capped at 3 as above.

**Take topics in the order listed.** The first is next unless the invocation
named a specific one — with `id:<queue id>`, write the topic carrying that id and
nothing else. If no queued topic has it, stop and say so rather than picking a
different one: the run was asked for that post.

**`images`, `words` and `cta` are already resolved** for each topic: the queue
has merged any per-topic override with the defaults, so use the values printed
against that topic and do not re-derive them.

**`words` is the length to write**, chosen in the dashboard. It is a midpoint,
not an exact number — see step 5.

**`notes`** is steering about angle or stance, and it outranks your own framing
judgement.

**`id`** matters. Carry it into the draft JSON as `topicId` so the importer can
mark that topic written. Without it the topic stays queued forever and gets
written again next time.

**`kind`** in brackets tells you which research path step 3 takes: `keyword`,
`link` or `site`.

**`categories`** is the list a post's `category` must come from. Every post
needs exactly one; pick the one the subject genuinely belongs to.

**The internal links list at the bottom is the whole set of pages you may link
to on our own site.** Read it now, before you outline: step 5 requires three to
six of them, and knowing which pages exist is what tells you which sections can
carry one. Copy the paths exactly as printed. A path that is not on that list
does not exist as far as this post is concerned — do not guess one, do not
construct one from a service name, and do not link to our homepage instead.

If that list comes back empty, stop and say so. Every post needs three internal
links, so an empty list is a broken run rather than a post to write anyway.

You never fetch or place images yourself. The importer pulls them from Pexels
and puts them under section headings, which is another reason step 5's headings
need to name real subjects.

## Step 3 — Research

This is where the post earns its keep. Use WebSearch and WebFetch to gather real
sources before writing a word.

A topic line is a keyword, a link, or a site. They start differently.

Tell a site from an article by the path: `techcrunch.com` or
`https://techcrunch.com/` is a site, `https://techcrunch.com/2026/08/some-story`
is an article.

### If the line is a bare domain (site mode)

The user is pointing at a publication, not a story. Find the story yourself.

1. Find what the site has published recently. WebFetch its homepage, or search
   `site:<domain>` for the last few weeks. Gather 10-20 candidate headlines
   with their URLs.
2. **Filter them against the agency's audience.** Apply
   `STORY_PICKER_SYSTEM_PROMPT` (printed in step 1) as written. A story counts
   only if a business decision-maker with a budget could read the post and
   become a client. It rejects politics, sport, celebrity, entertainment,
   crime, weather, gadget reviews, game releases, and pure company news with
   no wider consequence.
3. Pick the single best remaining story and state, in one line, the business
   question the post will answer. Then continue as link mode below.

**Returning nothing is a correct answer.** If the site published nothing that
passes, say "nothing worth writing" and stop. Do not write up the least-bad
option to fill the quota.

### If the line is an article URL (link mode)

The pasted article is the spine of the post.

1. WebFetch it first and read it properly. Note its publication date, its
   publisher, and what it actually claims.
2. Find 2-4 more sources that corroborate or add to it. A post resting on one
   article is a summary of someone else's work.
3. Write about the subject, not about the article. Never paraphrase it
   paragraph by paragraph, and never reproduce long passages of it.
4. In the JSON, set `sourceUrl` to the pasted URL and `sourceName` to the
   publisher, and include it in `sources` so it is credited.

If the page cannot be fetched, say so and stop rather than writing from the URL
slug and guesswork. A blocked link is a reason to report, not to invent.

### If the line is a keyword

Research the subject from scratch. No article is privileged, and `sourceUrl`
stays empty.

When search results need narrowing, `SOURCE_QUALITY_SYSTEM_PROMPT` (printed in
step 1) is the gate. Its most useful rule is the one easiest to forget: never
cite agencies, consultancies, studios or software vendors selling the same
services the article is about — other GoHighLevel agencies, white-label support
providers, automation shops — even when the page reads as neutral advice. A
competitor's helpful blog post is still a competitor's marketing. Judge by what
the publisher sells.

### Both modes

- Find 3-6 substantive sources. Read them properly with WebFetch — a search
  snippet is not a source.
- **Six WebFetch calls is the hard ceiling for a post, and it is a ceiling, not
  a target.** Search first, then read the search results and decide which few
  pages are worth opening. Every page you open stays in context and is re-sent
  on every turn afterwards. Four good sources beat twenty skimmed ones.
- If six pages did not yield enough to write from, say so and stop. Do not keep
  fetching in the hope that the next one helps.
- Prefer primary sources: GoHighLevel's own documentation and release notes,
  Twilio/Stripe/Meta/Google documentation, official pricing pages, original
  research. A listicle summarizing other listicles is worth nothing.
- Note the publication date of everything. It decides the framing in step 4.
- Never cite a competitor agency as a source in the finished post.

**The grounding rule is absolute.** Every fact, figure, name, date and quote in
the finished article must come from a source you actually read in this session.
Not from your training data, however confident you are. If you cannot source a
claim, cut it. Vague attribution ("industry data suggests", "one study found",
"many agencies report") is the same failure as inventing the number.

## Step 4 — Choose the framing

Based on the dates of what you found, pick one and hold to it. `MODE_RULES`
(printed in step 1) has the exact wording for each:

- **news-led** — sources from the last two weeks. You may treat it as current.
- **recent** — sources from the last few months. Attribute with the explicit
  date; never write "recently" or "just announced".
- **evergreen** — no recent dates. Make no claim about timeliness at all.

Getting this wrong is how a post ends up saying "the latest update" about
something eighteen months old.

## Step 5 — Write it

Follow the rules from step 1. The ones most often got wrong, in the order they
cost the most:

- **Paragraphs are one to three sentences.** Dense uniform paragraphs are the
  single clearest tell.
- **Vary how sentences begin.** Read your openings as a list. If most are a bare
  subject followed by its verb, the prose is uniform underneath.
- **Zero em dashes.** Not one. This is absolute.
- **Lists and tables are allowed, never required.** Prose is the default. Where
  the material genuinely is a set of parallel things, or a real side-by-side
  comparison, prefer the list or the table. Never add one to look organised.
- **The ceilings scale with the length you were given.** At 500 words: two
  lists, one table. At 1000: three lists, two tables. At 2000: four lists, two
  tables. Limits, not goals.
- **A short post can carry a table.** A four-row table of real numbers replaces
  the paragraphs that would have described the same comparison.
- **Three to six internal links, taken from the list `npm run blog:queue`
  printed in step 2.** Copy the paths character for character. Spread them
  through the piece, and write them as site-relative paths (`/services/...`)
  and never as full `https://` URLs. Fewer than three is a failed post and the
  audit in step 7 reports it as an error. Never pad to reach the count with a
  link the sentence did not want.
- **Three or four external links**, out to the sources you actually read. Put
  the link on the sentence that cites the figure, using that source's exact URL.
- **Anchor text names what is on the other end.** "Read more", "see here",
  "this study" and "click here" all fail. The link wraps words inside a sentence
  that was going to be written anyway; never let a link be its own sentence.
  Never link to a company selling services similar to ours, and never invent a
  URL.
- **The negation pivot is banned outright** — "it's not just X, it's Y" in every
  surface form.
- **Use contractions.** A long article with none reads as generated.
- **Commit to a view** where the sources support it.
- **Don't open by restating the title back at the reader.** The first sentence
  asserts something specific and falsifiable. The keyword still has to land in
  the first 120 words, inside a sentence that carries real information.

Place the token `[[CTA]]` on its own line at one natural break, middle-to-late in
the piece, after a section that delivered real value. Exactly once. Write no
call-to-action wording of your own around it.

Allowed HTML only: `<h2>`, `<h3>`, `<p>`, `<ul>`, `<ol>`, `<li>`, `<strong>`,
`<em>`, `<a>`, `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>`. No `<h1>`
— the title renders separately. No sources list in the body; the site renders
one from the JSON.

**Write to the `words` figure the queue printed against this topic — as a
midpoint, not an exact number.** The accepted band is 20% under to 30% over, so
`500` means roughly **400 to 650 words**, `1000` means 800 to 1300, and `2000`
means 1600 to 2600.

If the sources cannot honestly support the length, write the shorter piece and
say so in your report — never reach the number with invented specifics.

At 500 words the whole article is roughly three sections. Pick the single most
useful thing to say and say it properly. Section length should vary.

## Step 6 — Save the draft

Write `content/drafts/<slug>.json`:

```json
{
  "title": "...",
  "slug": "kebab-case-from-the-title",
  "excerpt": "1-2 sentences, max ~300 chars, not a copy of the title",
  "content": "<p>the article body as HTML</p>",
  "category": "one of the categories npm run blog:queue printed",
  "tags": ["2-6 short topical labels"],
  "seoTitle": "<=60 chars, contains the keyword",
  "seoDescription": "<=160 chars, reads as a search snippet",
  "seoKeywords": "comma-separated, 5-10 phrases, distinct from tags",
  "targetKeyword": "the keyword this post targets",
  "topicId": "the id from npm run blog:queue",
  "imageCount": 1,
  "targetWords": 500,
  "ctaVariant": "general",
  "researchMode": "evergreen",
  "sourceUrl": "",
  "sourceName": "",
  "sources": [
    { "url": "https://...", "name": "Publisher", "title": "Page title" }
  ]
}
```

`category` must be one of the categories the queue printed. `researchMode` is
the framing you chose in step 4. `ctaVariant` is the `cta` the queue printed
against the topic. `sourceUrl` and `sourceName` are the pasted article in link
mode, and empty strings for a keyword post.

`sources` is every page you actually read and used, and it is not optional.
The site renders it as a folded list under the article and the dashboard shows
it as the research panel. Do not list a page you did not read.

Always write `imageCount`, `targetWords` and `ctaVariant` explicitly: the topic
line's override if it had one, otherwise the defaults you read in step 2.

**Before you move on, check that `topicId`, `category` and `targetWords` are
all present and correct.** Each one fails silently when missing: a missing
`targetWords` is judged against the 500-word default, a missing `topicId`
leaves the queue topic unmarked so it is written again next run, and a missing
`category` defaults to GoHighLevel whether or not that is right.

## Step 7 — Audit it

Two passes, and both matter.

**First, read it yourself.** The script cannot see whether a fact came from a
source you actually read, whether the framing you chose held, or whether the
ending restates the article. Check those by hand:

1. **Facts** — is every figure, name and date traceable to a source you read
   this session?
2. **Framing** — does the piece honour the mode you picked?
3. **Sources** — is any single publisher carrying more than about a third?
4. **The ending** — does it restate the article? Cut that and finish on the most
   useful practical point.

**Then run the script**, which does the mechanical checks the same way every
time:

```
npm run blog:audit content/drafts/<slug>.json
```

It reports errors (rules the standard states absolutely: em dashes, list count,
CTA token, banned phrases, keyword placement, missing sources, zero internal
links, category) and warnings (judgement: length, paragraph size, adjacent
figures, repeated sentence openings). It exits non-zero if there are errors.

**This step is not optional and step 8 does not start while the audit is still
exiting non-zero.** Fixing means changing the article, not the audit.

- `internal links 0 found, at least 3 required` — go back to the list step 2
  printed and place three to six of those paths on sentences that were already
  going to be written.
- `length ... over the ... band` — cut a section rather than trimming words
  evenly out of all of them.

Warnings are judgement, so weigh them rather than obeying them — but do not
ignore one without a reason you could say out loud.

## Step 8 — Import

Run `npm run blog:import`. It saves everything as a **draft** unless the
dashboard has auto-publish on AND the audit is clean AND every internal link
resolves — then it goes live. It leaves already-published posts alone.

It also marks the queue topic written, using the `topicId` you carried into the
JSON. That happens automatically.

If the import reports `queue: marked "..." done` you are finished. If it does
not, the `topicId` was missing or wrong, and the topic will be written again
next run — worth fixing before you stop.

## Step 9 — Report

Tell the user, briefly:
- What you wrote and the word count.
- Which sources you used, as links, so they can spot-check the facts.
- Anything you deliberately left out for lack of a source.
- Whether it went live or is waiting in the dashboard under Blog as a draft.

Do not claim a post is good. Say what it is and let them read it.
