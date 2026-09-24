/**
 * Print the prose rules the writing workflow is held to.
 *
 * The FIRST thing a spawned writer session runs, per
 * .claude/commands/write-blog.md. Printed rather than read from source so the
 * session carries the rules alone in context, not the TypeScript around them.
 *
 *   npm run blog:rules
 */
import { printableStandard } from '../src/modules/blog-writer/lib/writing-standard.js'

console.log(printableStandard())
