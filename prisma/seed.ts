/**
 * Creates the admin login account in Supabase.
 *
 * Content is NOT seeded: the live project already holds real content, and
 * upserting the frontend's static copies over it would overwrite edits made
 * in the admin panel.
 *
 *   npm run db:seed
 */

import bcrypt from 'bcryptjs'
import supabase from '../src/config/supabase.js'
import env from '../src/config/env.js'
import { UserRole } from '../src/config/constants.js'

const email = env.SEED_ADMIN_EMAIL.toLowerCase()

const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle()

if (existing) {
  console.log(`\nAdmin user already exists: ${email}\n`)
} else {
  const { error } = await supabase.from('users').insert({
    email,
    password_hash: await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12),
    full_name: env.SEED_ADMIN_NAME,
    role: UserRole.ADMIN,
  })

  if (error) {
    console.error(`\nCould not create the admin user: ${error.message}\n`)
    process.exit(1)
  }

  console.log(`\nAdmin user created: ${email} / ${env.SEED_ADMIN_PASSWORD}\n`)
}
