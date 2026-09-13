import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import env from './env.js'

/**
 * Supabase client — Storage only now (`blogAi.images.ts`'s `blog-covers`
 * bucket for AI-generated cover images). Every table read/write moved to
 * Prisma (`config/prisma.ts`), which connects to whatever Postgres
 * DATABASE_URL points at — no longer necessarily Supabase's. Supabase
 * Storage is a separate product with no Prisma equivalent, which is the
 * only reason this client still exists, and it's optional: left
 * unconfigured, this is `null` and `blogAi.images.ts` falls back to the
 * placeholder cover image instead of crashing the app at boot.
 *
 * Authenticates with the secret (service-role) key — the correct choice
 * here because authorisation lives in this API's own JWT + role middleware,
 * and the key never leaves the server. `persistSession: false` matters on
 * serverless: there is no browser, nothing to persist into, and no state
 * should carry between invocations.
 */
const globalForSupabase = globalThis as typeof globalThis & {
  __ghlSupabaseClient?: SupabaseClient | null
}

function buildClient(): SupabaseClient | null {
  if (!env.hasSupabaseStorage) return null

  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'ghlprime-api' } },
  })
}

export const supabase: SupabaseClient | null = globalForSupabase.__ghlSupabaseClient ?? buildClient()
globalForSupabase.__ghlSupabaseClient = supabase

export default supabase
