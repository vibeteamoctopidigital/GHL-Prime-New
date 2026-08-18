import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import env from './env.js'
import logger from '../shared/utils/logger.js'

/**
 * Supabase client used for ALL data access.
 *
 * Authenticates with the secret (service-role) key, which bypasses RLS — the
 * correct choice here because authorisation lives in this API's own JWT + role
 * middleware, and the key never leaves the server.
 *
 * `persistSession: false` matters on serverless: there is no browser, nothing
 * to persist into, and no state should carry between invocations.
 */
const globalForSupabase = globalThis as typeof globalThis & {
  __ghlSupabaseClient?: SupabaseClient
}

export const supabase: SupabaseClient =
  globalForSupabase.__ghlSupabaseClient ??
  createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
    global: { headers: { 'x-application-name': 'ghlprime-api' } },
  })

globalForSupabase.__ghlSupabaseClient = supabase

/** Proves the project is reachable and the key is accepted. */
export async function connectDatabase(): Promise<void> {
  const { error } = await supabase.from('case_studies').select('id', { head: true, count: 'exact' })

  if (error) {
    throw new Error(
      `Cannot reach Supabase (${env.SUPABASE_URL}): ${error.message}. ` +
        'Check SUPABASE_URL and SUPABASE_SECRET_KEY.',
    )
  }

  logger.info(`Supabase connected (${new URL(env.SUPABASE_URL).hostname})`)
}

/** Nothing to close — PostgREST is stateless HTTP. */
export async function disconnectDatabase(): Promise<void> {
  logger.info('Supabase client released')
}

export default supabase
