/**
 * Walks the Express router stack and prints every registered route.
 *
 * Used to prove the API test suite covers the whole surface: this is the
 * ground truth, derived from the app itself rather than from documentation
 * that can drift.
 *
 *   npm run routes           # human-readable table
 *   npm run routes -- --json # writes scripts/.routes.json for the API test
 */

import path from 'node:path'
import { writeFileSync } from 'node:fs'
import createApp from '../src/app.js'
import env, { ROOT_DIR } from '../src/config/env.js'

interface RouteEntry {
  method: string
  path: string
}

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: unknown[] }
  name?: string
  handle?: { stack?: Layer[] }
  regexp?: RegExp & { fast_slash?: boolean }
}

/** Recovers a router's mount path from the regexp Express compiled it into. */
function mountPathFromLayer(layer: Layer): string {
  if (!layer.regexp || layer.regexp.fast_slash) return ''

  const source = layer.regexp.source
  const match = /^\^\\\/(?<path>.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source)
  if (!match?.groups?.['path']) return ''

  return `/${match.groups['path'].replace(/\\\//g, '/').replace(/\\\./g, '.')}`
}

function collect(stack: Layer[], prefix = ''): RouteEntry[] {
  const routes: RouteEntry[] = []

  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]

      for (const routePath of paths) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled || method === '_all') continue
          const full = `${prefix}${routePath}`.replace(/\/{2,}/g, '/') || '/'
          routes.push({ method: method.toUpperCase(), path: full })
        }
      }
      continue
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...collect(layer.handle.stack, `${prefix}${mountPathFromLayer(layer)}`))
    }
  }

  return routes
}

const app = createApp()
const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack

// De-duplicate: a router mounted twice (e.g. /team and /team/members) yields
// the same handler under two prefixes, and both are real, callable paths.
const seen = new Set<string>()
const routes = collect(stack)
  .filter((route) => {
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))

if (process.argv.includes('--json')) {
  // Written to a file rather than stdout so startup log lines cannot corrupt it.
  const STANDARD_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

  // `app.all()` registers one entry per HTTP verb; keep a single representative.
  const testable = routes.filter(
    (route) => STANDARD_METHODS.has(route.method) && !(route.path === '/free-scripts' && route.method !== 'GET'),
  )

  const outPath = path.join(ROOT_DIR, 'scripts', '.routes.json')
  writeFileSync(outPath, JSON.stringify(testable, null, 2))

  console.log(`Wrote ${testable.length} testable routes (of ${routes.length} registered) to ${outPath}`)
} else {
  const groups = new Map<string, RouteEntry[]>()

  for (const route of routes) {
    const group = route.path.startsWith(env.API_PREFIX)
      ? (route.path.slice(env.API_PREFIX.length).split('/')[1] ?? 'root')
      : 'compat'

    groups.set(group, [...(groups.get(group) ?? []), route])
  }

  console.log(`\nRegistered routes (${routes.length} total)\n`)

  for (const [group, entries] of [...groups.entries()].sort()) {
    console.log(`── ${group || 'root'} (${entries.length})`)
    for (const entry of entries) console.log(`   ${entry.method.padEnd(7)} ${entry.path}`)
    console.log()
  }
}

process.exit(0)
