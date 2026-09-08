import crypto from 'node:crypto'
import env from '../../config/env.js'

/**
 * AES-256-GCM encryption for the Anthropic/OpenAI API keys admins paste into
 * the Auto Blog settings UI. Never stored in plaintext.
 *
 * TOKEN_ENCRYPTION_KEY is validated at boot (config/env.ts) to be exactly 32
 * raw bytes, hex-encoded.
 */
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // recommended IV length for GCM

const getKey = (): Buffer => Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'hex')

/**
 * Encrypts `plain` and returns a colon-joined "iv:authTag:ciphertext" string
 * (all base64), suitable for storing directly in a `token` column. A fresh
 * random IV is generated on every call — never reuse an IV with GCM.
 */
export function encryptToken(plain: string): string {
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

/** Reverses encryptToken(). Throws if `stored` is malformed or the auth tag doesn't verify. */
export function decryptToken(stored: string): string {
  const parts = String(stored || '').split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted token value')
  }

  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string]
  const key = getKey()
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString('utf8')
}
