/**
 * Audit a draft against the writing standard.
 *
 *   npm run blog:audit content/drafts/<slug>.json
 *
 * Prints every finding, then "N error(s), M warning(s)". Exits non-zero when
 * there are errors, which is what lets the workflow refuse to import a draft
 * that breaks a hard rule. The same checks gate auto-publish in the importer.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { audit } from '../src/modules/blog-writer/lib/audit.js'

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: npm run blog:audit content/drafts/<slug>.json')
    process.exit(2)
  }

  const full = path.resolve(process.cwd(), file)
  let draft: Record<string, unknown>
  try {
    draft = JSON.parse(await readFile(full, 'utf8')) as Record<string, unknown>
  } catch (error) {
    console.error(`${file}: not valid JSON — ${(error as Error).message}`)
    process.exit(2)
  }

  const findings = audit(draft)
  const errors = findings.filter((finding) => finding.level === 'error')
  const warnings = findings.filter((finding) => finding.level === 'warn')

  console.log(`${path.basename(full)}\n`)
  for (const finding of findings) {
    console.log(`  ${finding.level === 'error' ? 'ERROR' : 'warn '}  ${finding.check}: ${finding.detail}`)
  }
  if (findings.length === 0) console.log('  clean')

  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`)
  process.exitCode = errors.length > 0 ? 1 : 0
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
