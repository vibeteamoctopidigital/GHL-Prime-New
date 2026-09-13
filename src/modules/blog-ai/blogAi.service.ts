import prisma from '../../config/prisma.js'
import ApiError from '../../shared/utils/ApiError.js'
import { encryptToken } from '../../shared/utils/tokenCrypto.js'
import { toSnakeCase } from '../../shared/serializers/caseTransform.js'
import { codexLoginStatus } from './blogAi.cliRunner.js'
import { DEFAULT_BLOG_CATEGORIES } from './blogAi.validators.js'
import type { AuthType, BlogAiProvider, CreateAccountBody, UpdateAccountBody, UpdateSettingsBody } from './blogAi.validators.js'
import type { SerializedRow } from '../../types/common.js'

/**
 * Settings kept snake_case end to end (matching the DB columns and the rest
 * of this API's wire format) — only the PUT body arrives camelCase and gets
 * converted once, on the way in.
 */
export interface BlogAiSettings {
  instructions: string
  keywords: string
  advanced_instructions: string
  categories: string[]
  /** Master on/off switch for the daily scheduled run — Run Now ignores this and always works regardless. */
  auto_blog_enabled: boolean
  schedule_hour: number
  /** Minute component of the daily schedule, alongside schedule_hour — both interpreted as UTC. */
  schedule_minute: number
  posts_per_day: number
  primary_provider: BlogAiProvider
  fallback_enabled: boolean
  anthropic_model: string
  openai_model: string
  // -- Auto Blog v2: review workflow, style rules, research, images --------
  style_rules: string
  topic_focus_areas: string[]
  review_window_minutes: number
  image_generation_enabled: boolean
  web_search_enabled: boolean
  min_seo_score: number
  // -- Content-quality rules: SEO/link/formatting policy -------------------
  competitor_domains: string[]
  max_internal_links: number
  blog_url_path: string
  // -- CLI/subscription-based accounts --------------------------------------
  /** Overrides env.CLAUDE_CLI_PATH — set only if the `claude` binary isn't on PATH. */
  claude_cli_command: string
  /** Overrides env.CODEX_CLI_PATH — set only if the `codex` binary isn't on PATH. */
  codex_cli_command: string
  /** Codex has no per-account rotation — a single ambient `codex login --device-auth` session, on/off. */
  codex_enabled: boolean
  /** Used for a post's cover image when no OpenAI API key account is configured — Claude cannot generate images at all. */
  placeholder_cover_image_url: string
}

const DEFAULT_SETTINGS: BlogAiSettings = {
  // Promoted from the settings form's own placeholder copy (AdminBlogAiPage.jsx)
  // so a fresh install starts from a sensible baseline instead of blank text
  // that would otherwise generate posts with zero style/keyword direction.
  instructions: 'Write in a confident, practical tone for GoHighLevel agency owners. Favor concrete examples over theory.',
  keywords: 'gohighlevel automation, ai agents for agencies, crm workflows',
  advanced_instructions: '',
  categories: DEFAULT_BLOG_CATEGORIES,
  auto_blog_enabled: true,
  schedule_hour: 10,
  schedule_minute: 0,
  posts_per_day: 1,
  primary_provider: 'anthropic',
  fallback_enabled: false,
  anthropic_model: '',
  openai_model: '',
  style_rules: 'Do not use em dashes. Write short, clear sentences aimed at a general reader. Avoid jargon. Prefer active voice.',
  topic_focus_areas: ['AI automation', 'CRM', 'GoHighLevel', 'Web Development'],
  review_window_minutes: 20,
  image_generation_enabled: true,
  web_search_enabled: true,
  min_seo_score: 70,
  competitor_domains: [],
  max_internal_links: 3,
  blog_url_path: '/blog',
  claude_cli_command: '',
  codex_cli_command: '',
  codex_enabled: false,
  placeholder_cover_image_url: '',
}

/** The encrypted `token` column is NEVER selected here — only `token_preview`. */
const ACCOUNT_SAFE_SELECT = {
  id: true,
  provider: true,
  label: true,
  token_preview: true,
  model: true,
  auth_type: true,
  enabled: true,
  status: true,
  cooldown_until: true,
  done_count: true,
  failed_count: true,
  last_used_at: true,
  last_error: true,
  created_at: true,
}

/** Row shape needed to actually call a provider — includes the encrypted token. */
export interface EngineAccount {
  id: string
  provider: BlogAiProvider
  label: string
  token: string
  auth_type: AuthType
  model: string | null
  done_count: number
  failed_count: number
}

/**
 * What actually resolves for a given provider once accounts + ambient Codex
 * are considered — the engine/checker/research modules dispatch on
 * `transport` rather than re-deriving this logic themselves.
 *   - 'claude-cli': a blog_ai_accounts row (oauth subscription OR an
 *     advanced api_key), invoked by shelling out to the `claude` CLI.
 *   - 'codex-cli': the single ambient `codex login --device-auth` session —
 *     no accounts-table row at all.
 *   - 'openai-api': a blog_ai_accounts row with provider='openai' (always a
 *     plain API key — there's no per-account OAuth concept for OpenAI here),
 *     invoked via the direct OpenAI SDK.
 */
export type ProviderRuntime =
  | { provider: 'anthropic'; transport: 'claude-cli'; account: EngineAccount }
  | { provider: 'openai'; transport: 'codex-cli' }
  | { provider: 'openai'; transport: 'openai-api'; account: EngineAccount }

/** True for Prisma's "record to update/delete not found" error (P2025). */
const isPrismaNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2025'

class BlogAiService {
  async getSettings(): Promise<BlogAiSettings> {
    const row = await prisma.blogAiSettings.findUnique({ where: { id: true } })
    return { ...DEFAULT_SETTINGS, ...(row as unknown as Partial<BlogAiSettings> | null) }
  }

  /** Merges `fields` onto the EXISTING settings row, not onto the hardcoded defaults. */
  async saveSettings(fields: UpdateSettingsBody): Promise<BlogAiSettings> {
    const current = await this.getSettings()
    const patch = toSnakeCase<Partial<BlogAiSettings>>(fields)
    const next: BlogAiSettings = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    }

    // `optionalString` (shared across the whole app, used for genuinely
    // nullable columns elsewhere) turns a blank textarea/input into `null` —
    // but every string-typed column on this table is `NOT NULL DEFAULT ''`.
    // Left unhandled, saving the form with ANY text field empty would send
    // a real SQL NULL and fail the whole upsert with a not-null constraint
    // violation, not just clear that one field. Coerce back to '' for any
    // field whose default is a string.
    const nextAsRecord = next as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(next)) {
      if (value === null && typeof DEFAULT_SETTINGS[key as keyof BlogAiSettings] === 'string') {
        nextAsRecord[key] = ''
      }
    }

    let saved: unknown
    try {
      saved = await prisma.blogAiSettings.upsert({
        where: { id: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically built from the full settings shape, same as the rest of this dynamic-config table.
        create: { id: true, ...next } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: next as any,
      })
    } catch (error) {
      throw ApiError.internal(`Could not save Auto Blog settings: ${error instanceof Error ? error.message : String(error)}`)
    }

    return { ...DEFAULT_SETTINGS, ...(saved as Partial<BlogAiSettings>) }
  }

  async listAccounts(): Promise<SerializedRow[]> {
    const rows = await prisma.blogAiAccount.findMany({ select: ACCOUNT_SAFE_SELECT, orderBy: { created_at: 'asc' } })
    return rows as unknown as SerializedRow[]
  }

  async createAccount(body: CreateAccountBody): Promise<SerializedRow> {
    return this.saveConnectedAccount({
      provider: body.provider,
      label: body.label,
      rawToken: body.apiKey,
      authType: body.authType,
      model: body.model ?? null,
    })
  }

  /**
   * Shared account-creation logic for every way an admin can add a Claude
   * account: pasting an already-generated token/key by hand (createAccount()
   * above), and the browser-based "Connect a Claude account" pty flow
   * (blogAi.cliConnect.ts, which captures the token automatically from
   * `claude setup-token`'s own output — always authType 'oauth'). Both end
   * up with a raw secret string that gets encrypted + inserted identically,
   * only `auth_type` differs, so this is the single place that does it.
   */
  async saveConnectedAccount(opts: {
    provider: BlogAiProvider
    label: string
    rawToken: string
    authType: AuthType
    model?: string | null
  }): Promise<SerializedRow> {
    const tokenPreview = opts.rawToken.slice(-4)
    const encryptedToken = encryptToken(opts.rawToken)

    try {
      const created = await prisma.blogAiAccount.create({
        data: {
          provider: opts.provider,
          label: opts.label,
          token: encryptedToken,
          token_preview: tokenPreview,
          auth_type: opts.authType,
          model: opts.model || null,
          enabled: true,
        },
        select: ACCOUNT_SAFE_SELECT,
      })
      return created as unknown as SerializedRow
    } catch (error) {
      throw ApiError.internal(`Could not save account: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Enable/disable/label/model updates only — token rotation is deliberately
   * not supported here. To rotate a key, delete and recreate the account.
   */
  async updateAccount(id: string, body: UpdateAccountBody): Promise<SerializedRow> {
    const columns = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))
    if (Object.keys(columns).length === 0) return this.findAccountOrFail(id)

    try {
      const updated = await prisma.blogAiAccount.update({ where: { id }, data: columns, select: ACCOUNT_SAFE_SELECT })
      return updated as unknown as SerializedRow
    } catch (error) {
      if (isPrismaNotFound(error)) throw ApiError.notFound('Account not found')
      throw ApiError.internal(`Could not update account: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async deleteAccount(id: string): Promise<void> {
    try {
      await prisma.blogAiAccount.delete({ where: { id } })
    } catch (error) {
      if (isPrismaNotFound(error)) throw ApiError.notFound('Account not found')
      throw ApiError.internal(`Could not delete account: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async findAccountOrFail(id: string): Promise<SerializedRow> {
    const row = await prisma.blogAiAccount.findUnique({ where: { id }, select: ACCOUNT_SAFE_SELECT })
    if (!row) throw ApiError.notFound('Account not found')
    return row as unknown as SerializedRow
  }

  /** Row WITH the encrypted token — internal use only (testing / engine runs), never returned via the API. */
  async getAccountWithToken(id: string): Promise<SerializedRow | null> {
    const row = await prisma.blogAiAccount.findUnique({ where: { id } })
    return row as unknown as SerializedRow | null
  }

  /**
   * Picks the least-recently-used enabled, off-cooldown account for a
   * provider. Shared by the generation engine and the AI-checker (which
   * needs an account for whichever provider did NOT write the draft), so
   * there's exactly one place that knows the rotation/cooldown rule.
   *
   * `opts.authType`, when given, restricts the pick to that auth type only —
   * used by the scheduled/cron run to exclude 'api_key' (metered-billing)
   * accounts entirely, so an automatic daily run can never rack up API
   * charges even if an admin has an api_key account configured as a fallback
   * for manual runs.
   */
  async pickAvailableAccount(provider: BlogAiProvider, opts: { authType?: AuthType } = {}): Promise<EngineAccount | null> {
    const account = await prisma.blogAiAccount.findFirst({
      where: {
        provider,
        enabled: true,
        OR: [{ cooldown_until: null }, { cooldown_until: { lt: new Date() } }],
        ...(opts.authType ? { auth_type: opts.authType } : {}),
      },
      orderBy: { last_used_at: { sort: 'asc', nulls: 'first' } },
    })

    return (account as unknown as EngineAccount) ?? null
  }

  /**
   * Codex has no accounts-table rotation — it's a single ambient
   * `codex login --device-auth` session on the box. "Available" means the
   * admin has turned it on AND the ambient login is currently valid.
   */
  async getCodexAvailability(): Promise<{ available: boolean; reason?: string }> {
    const settings = await this.getSettings()
    if (!settings.codex_enabled) return { available: false, reason: 'Codex is disabled in settings' }

    const status = await codexLoginStatus(settings.codex_cli_command || undefined)
    if (!status.loggedIn) return { available: false, reason: 'No active Codex login — connect it from the AI Connections page' }

    return { available: true }
  }

  /**
   * The single place that decides how a provider actually gets called.
   * Prefers the flat-rate/ambient path over a metered API key wherever both
   * could apply, since avoiding per-token billing is the whole point of the
   * CLI/subscription model.
   *
   * `billingSafeOnly` is a hard constraint, not just a preference — used by
   * the automatic daily cron run (blogAi.scheduler.ts), which must never
   * incur metered API charges unattended. When set: only an 'oauth'
   * (subscription) Claude account is eligible (an 'api_key' account is
   * skipped entirely, even if it's the only one available), and OpenAI can
   * only resolve to the free ambient Codex login — never an api_key account.
   * Manual runs (Run Now, the AI-checker) leave this off, matching the
   * existing behavior admins already opted into by adding an api_key account
   * as an explicit fallback.
   */
  async resolveProviderRuntime(provider: BlogAiProvider, opts: { billingSafeOnly?: boolean } = {}): Promise<ProviderRuntime | null> {
    if (provider === 'anthropic') {
      const account = await this.pickAvailableAccount('anthropic', opts.billingSafeOnly ? { authType: 'oauth' } : {})
      return account ? { provider: 'anthropic', transport: 'claude-cli', account } : null
    }

    const codex = await this.getCodexAvailability()
    if (codex.available) return { provider: 'openai', transport: 'codex-cli' }

    if (opts.billingSafeOnly) return null

    const account = await this.pickAvailableAccount('openai')
    return account ? { provider: 'openai', transport: 'openai-api', account } : null
  }

  async listRuns(limit = 50): Promise<SerializedRow[]> {
    const rows = await prisma.blogAiRun.findMany({
      include: { blog_post: { select: { title: true, slug: true, published: true } } },
      orderBy: { started_at: 'desc' },
      take: limit,
    })

    return rows as unknown as SerializedRow[]
  }
}

export const blogAiService = new BlogAiService()
export default blogAiService
