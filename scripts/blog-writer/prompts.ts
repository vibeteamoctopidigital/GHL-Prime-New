/**
 * The writing standard every Blog Writer post must follow. A spawned `claude`
 * session reads this (via `npm run blog:rules`, the first thing
 * .claude/commands/write-blog.md tells it to do) before writing anything —
 * this is what keeps every auto-generated post consistent regardless of
 * which topic or schedule triggered it.
 *
 * Kept as a single function of the live settings (not a static string) so an
 * admin changing style_rules/categories/max_internal_links in the settings
 * screen changes what the next run actually reads, with no redeploy.
 */

export interface WritingStandardSettings {
  style_rules: string
  categories: string[]
  max_internal_links: number
  min_seo_score: number
  competitor_domains: string[]
}

export function getWritingStandard(settings: WritingStandardSettings): string {
  const categoryList = settings.categories.length ? settings.categories.join(', ') : '(none configured)'
  const competitorNote = settings.competitor_domains.length
    ? `Do not link to, or lift structure/wording from, these competitor domains: ${settings.competitor_domains.join(', ')}.`
    : 'No competitor domains are configured to avoid.'

  return `# GHL Prime Blog Writer — writing standard

## Voice and style
${settings.style_rules}

## Structure
- One clear H1-equivalent title (the \`title\` field — do not repeat it as an H2 inside the body).
- Break the body into scannable H2/H3 sections. No wall-of-text paragraphs longer than ~4 sentences.
- Open with a short, concrete paragraph that states what the reader will get from the post — no throat-clearing.
- Close with a brief, specific takeaway or next step. Not a generic "in conclusion."

## Category
Pick exactly one from: ${categoryList}. If the topic genuinely fits none of these, use the closest one rather than inventing a new category — the admin can recategorize later.

## SEO
- \`target_keyword\` must appear naturally in the title, the first paragraph, and at least one H2.
- \`seo_title\` <= 60 characters, \`seo_description\` <= 155 characters, both written for a human reader first, keyword-present second.
- Include at most ${settings.max_internal_links} internal links (to other GHL Prime pages/posts) — 0 is fine, more is a link-stuffing audit failure.
- The audit (\`npm run blog:audit\`) enforces a minimum SEO score of ${settings.min_seo_score}/100 before auto-publish is allowed.

## Sourcing
${competitorNote}
Cite real sources for any claim, statistic, or "as of" date — a post with fabricated statistics is exactly what the audit exists to catch. When \`research_mode\` is "sources", the topic itself came from ranked real headlines — stay grounded in what those sources actually say rather than inventing an angle they don't support.

## What NOT to do
- No em dashes (—). No filler like "in today's fast-paced world" or "in conclusion."
- No inventing quotes, statistics, or named case studies that didn't come from real research this session did.
- Do not claim a feature, integration, or capability exists unless the research step actually confirmed it.
`
}
