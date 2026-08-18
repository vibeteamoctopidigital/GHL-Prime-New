import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Walks up from this module until it finds the package root (the directory
 * holding package.json). A fixed '../..' would land in `dist/` once compiled,
 * where there is no .env — so the built server would boot without config.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, 'package.json'))) return dir

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return process.cwd()
}

/** Backend package root — used to resolve relative paths from .env. */
export const ROOT_DIR = findPackageRoot(currentDir)

dotenv.config({ path: path.join(ROOT_DIR, '.env') })

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().startsWith('/').default('/api'),

  // --- Supabase (database via PostgREST) ------------------------------------
  // All data access uses the secret (service-role) key over HTTPS. There is no
  // Postgres connection string and no ORM connection pool.
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SECRET_KEY: z.string().min(20, 'SUPABASE_SECRET_KEY is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  SITE_URL: z.string().url().default('https://ghlprime.com'),
  SITEMAP_REFRESH_TOKEN: z.string().optional().default(''),
  SITEMAP_OUTPUT_DIR: z.string().default('public'),

  CONTACT_WEBHOOK_URL: z.string().optional().default(''),
  CONTACT_MIN_FILL_MS: z.coerce.number().int().nonnegative().default(2500),
  SURVEY_WEBHOOK_URL: z.string().optional().default(''),

  // --- Cloudinary (image uploads) ------------------------------------------
  // Deliberately optional: the API must boot and serve every other route before
  // these credentials are filled in. Upload routes report 503 until then.
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  /** Alternative single-string form: cloudinary://key:secret@cloud_name */
  CLOUDINARY_URL: z.string().optional().default(''),
  CLOUDINARY_UPLOAD_FOLDER: z.string().default('ghlprime'),
  /**
   * Unsigned upload preset name. When set, uploads go through the unsigned
   * endpoint instead of a signed one — the only path that works on a product
   * environment whose keys are denied the \ action.
   */
  CLOUDINARY_UPLOAD_PRESET: z.string().optional().default(''),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().max(100).default(10),
  MAX_UPLOAD_FILES: z.coerce.number().int().positive().max(50).default(10),

  SEED_ADMIN_EMAIL: z.string().email().default('admin@ghlprime.com'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
  SEED_ADMIN_NAME: z.string().default('GHL Prime Admin'),
})

export type RawEnv = z.infer<typeof envSchema>

/**
 * Catches a value whose placeholder was never filled in, e.g. `[YOUR-KEY]`.
 * Without this the server starts happily and fails later with an opaque 401
 * from PostgREST, which is a much worse place to discover the problem.
 */
function assertNoPlaceholders(name: string, value: string | undefined): void {
  if (!value) return

  const placeholder = /\[([A-Z0-9_-]+)\]/i.exec(value)
  if (!placeholder) return

  console.error(
    `\nInvalid environment configuration:\n` +
      `  - ${name} still contains the placeholder "${placeholder[0]}".\n` +
      `    Fill it in from the Supabase dashboard → Project Settings → API.\n`,
  )
  process.exit(1)
}

assertNoPlaceholders('SUPABASE_URL', process.env['SUPABASE_URL'])
assertNoPlaceholders('SUPABASE_SECRET_KEY', process.env['SUPABASE_SECRET_KEY'])

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
  // Fail fast: a half-configured server is worse than one that refuses to boot.
  console.error(`\nInvalid environment configuration:\n${details}\n`)
  process.exit(1)
}

const raw: RawEnv = parsed.data

export interface AppEnv extends RawEnv {
  isProduction: boolean
  isDevelopment: boolean
  isTest: boolean
  corsOrigins: string[]
  sitemapOutputDir: string
  /** True once Cloudinary credentials are present, in either supported form. */
  hasCloudinary: boolean
  /** True when an unsigned upload preset is configured. */
  hasUploadPreset: boolean
  /** The limit actually enforced — clamped below the platform cap on serverless. */
  effectiveMaxUploadMb: number
  maxUploadBytes: number
  /**
   * True on Vercel / AWS Lambda. The filesystem is read-only apart from /tmp,
   * and work queued after a response is not guaranteed to run, so a few
   * behaviours change (see sitemap.service.ts).
   */
  isServerless: boolean
}

const isServerless = Boolean(process.env['VERCEL'] ?? process.env['AWS_LAMBDA_FUNCTION_NAME'])

/**
 * Vercel rejects request bodies over ~4.5MB at the platform edge, before the
 * function runs — so a larger configured limit could never be honoured and the
 * caller would get an opaque platform 413 instead of our own error.
 *
 * The limit is clamped to a safe 4MB there. Bigger files should use
 * `GET /uploads/signature` and upload straight to Cloudinary from the browser,
 * which bypasses this function entirely.
 */
const SERVERLESS_UPLOAD_CEILING_MB = 4

const effectiveMaxUploadMb = isServerless
  ? Math.min(raw.MAX_UPLOAD_SIZE_MB, SERVERLESS_UPLOAD_CEILING_MB)
  : raw.MAX_UPLOAD_SIZE_MB

/** Either the three discrete vars, or the single CLOUDINARY_URL, is enough. */
const hasCloudinary = Boolean(
  (raw.CLOUDINARY_CLOUD_NAME && raw.CLOUDINARY_API_KEY && raw.CLOUDINARY_API_SECRET) ||
    raw.CLOUDINARY_URL.startsWith('cloudinary://'),
)

export const env: AppEnv = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  corsOrigins: csv(raw.CORS_ORIGINS),
  sitemapOutputDir: path.isAbsolute(raw.SITEMAP_OUTPUT_DIR)
    ? raw.SITEMAP_OUTPUT_DIR
    : path.resolve(ROOT_DIR, raw.SITEMAP_OUTPUT_DIR),
  hasCloudinary,
  hasUploadPreset: Boolean(raw.CLOUDINARY_UPLOAD_PRESET),
  effectiveMaxUploadMb,
  maxUploadBytes: Math.round(effectiveMaxUploadMb * 1024 * 1024),
  isServerless,
}

if (isServerless && raw.MAX_UPLOAD_SIZE_MB > SERVERLESS_UPLOAD_CEILING_MB) {
  console.warn(
    `[env] MAX_UPLOAD_SIZE_MB=${raw.MAX_UPLOAD_SIZE_MB} exceeds the serverless request-body cap; ` +
      `clamped to ${SERVERLESS_UPLOAD_CEILING_MB}MB. Use GET /uploads/signature for larger files.`,
  )
}

export default env
