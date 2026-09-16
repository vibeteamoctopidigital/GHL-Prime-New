/**
 * Prints the current writing standard. The FIRST thing a spawned writer
 * session runs, per .claude/commands/write-blog.md — so its context always
 * reflects whatever an admin has saved on the Blog Writer settings screen,
 * not a stale copy baked into the workflow file itself.
 *
 *   npm run blog:rules
 */
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import { getWritingStandard } from './blog-writer/prompts.js'

try {
  const settings = await prisma.blogWriterSettings.upsert({
    where: { id: true },
    update: {},
    create: { id: true },
  })

  console.log(getWritingStandard(settings))
} catch (error) {
  console.error('blog:rules failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
