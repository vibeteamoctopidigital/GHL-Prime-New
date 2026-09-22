import path from 'node:path'
import type { RunPhase } from './rules.js'

/**
 * Reading a writing run's progress out of the Claude Code event stream.
 *
 * Separated from scripts/blog-watch.ts so the interpretation can be exercised
 * without spawning anything: the watcher owns the process, this owns what its
 * output means. Everything here is pure — events in, phases out.
 */

export type Progress = { phase: RunPhase; detail: string }

/**
 * Turn the writer's own actions into the phases the dashboard shows.
 *
 * Every phase here is inferred from a tool the writer actually called, so the
 * card cannot claim progress that did not happen. Unrecognised events are
 * ignored rather than guessed at: a workflow step this does not know about
 * leaves the card on the previous phase, which is merely uninformative; a
 * wrong guess is misleading.
 */
export class RunTracker {
  private phase: RunPhase = 'starting'
  private sourcesRead = 0
  /** tool_use ids worth reading the result of, by what they were doing. */
  private pending = new Map<string, 'import' | 'audit'>()
  /** Human-readable trail, kept for the failure message the editor sees. */
  readonly transcript: string[] = []
  /** The slug the importer reported saving, once it has. */
  slug = ''

  constructor(private readonly emit: (progress: Progress) => void) {}

  private to(phase: RunPhase, detail: string): void {
    this.phase = phase
    this.emit({ phase, detail })
  }

  /** One NDJSON event from `--output-format stream-json`. */
  ingest(event: Record<string, unknown>): void {
    const type = event['type']

    if (type === 'assistant') {
      const message = event['message'] as { content?: unknown } | undefined
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const block of blocks as Record<string, unknown>[]) {
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
          this.transcript.push(block['text'].trim())
        }
        if (block['type'] === 'tool_use') this.onToolUse(block)
      }
      return
    }

    if (type === 'user') {
      const message = event['message'] as { content?: unknown } | undefined
      const blocks = Array.isArray(message?.content) ? message.content : []
      for (const block of blocks as Record<string, unknown>[]) {
        if (block['type'] === 'tool_result') this.onToolResult(block)
      }
      return
    }

    // The one failure this setup has already hit: the subscription's
    // allowance, not a bug in the workflow.
    if (type === 'rate_limit_event') {
      const info = event['rate_limit_info'] as { status?: unknown } | undefined
      if (info?.status && info.status !== 'allowed') {
        this.transcript.push(`rate limit: ${String(info.status)}`)
      }
    }
  }

  private onToolUse(block: Record<string, unknown>): void {
    const name = typeof block['name'] === 'string' ? block['name'] : ''
    const input = (block['input'] ?? {}) as Record<string, unknown>
    const id = typeof block['id'] === 'string' ? block['id'] : ''
    const target = [input['file_path'], input['command'], input['pattern'], input['query'], input['url']]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')

    this.transcript.push(`${name}: ${target.slice(0, 120)}`)

    if (name === 'WebSearch' || name === 'WebFetch') {
      this.sourcesRead += 1
      this.to('research', `${this.sourcesRead} source${this.sourcesRead === 1 ? '' : 's'} read`)
      return
    }

    if (name === 'Write' && /content[\\/]drafts/.test(target)) {
      // The draft file appearing is the first moment the run proves it wrote
      // anything, and naming the file is more use than a bare "writing".
      this.to('writing', path.basename(target))
      return
    }

    if (name === 'Bash') {
      if (/blog:audit/.test(target)) {
        if (id) this.pending.set(id, 'audit')
        this.to('audit', '')
        return
      }
      if (/blog:import/.test(target)) {
        if (id) this.pending.set(id, 'import')
        // Images are fetched by the importer before anything is saved, so
        // this phase is where the run genuinely is once the import starts.
        this.to('images', 'fetching from Pexels')
        return
      }
      return
    }

    // Reading the repo before any research has started is the workflow
    // loading the writing standard.
    if ((name === 'Read' || name === 'Glob' || name === 'Grep') && this.phase === 'starting') {
      this.to('standard', '')
    }
  }

  private onToolResult(block: Record<string, unknown>): void {
    const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : ''
    const kind = this.pending.get(id)
    if (!kind) return
    this.pending.delete(id)

    const text = flattenToolResult(block['content'])

    if (kind === 'audit') {
      const counts = text.match(/(\d+) error\(s\), (\d+) warning\(s\)/)
      this.to('audit', counts ? `${counts[1]} error(s), ${counts[2]} warning(s)` : '')
      return
    }

    // The importer names what it did and to which slug; that line is the only
    // place the post's identity is known, and the request row links to it.
    const saved = text.match(/(created|updated) (draft|published) "([^"]+)"/)
    if (saved) {
      this.slug = saved[3] ?? ''
      this.to('saving', saved[2] === 'published' ? 'published' : 'saved as a draft')
    } else {
      this.to('saving', '')
    }

    const held = text.match(/held as a draft — [^\n]+/)
    if (held) this.transcript.push(held[0])
  }
}

/** tool_result content is a string on some tools and a block list on others. */
export function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('\n')
}
