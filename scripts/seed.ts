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
import prisma, { disconnectDatabase } from '../src/config/prisma.js'
import env from '../src/config/env.js'
import { UserRole } from '../src/config/constants.js'

const email = env.SEED_ADMIN_EMAIL.toLowerCase()

const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } })

if (existing) {
  console.log(`\nAdmin user already exists: ${email}\n`)
} else {
  try {
    await prisma.user.create({
      data: {
        email,
        password_hash: await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12),
        full_name: env.SEED_ADMIN_NAME,
        role: UserRole.ADMIN,
      },
    })
    console.log(`\nAdmin user created: ${email} / ${env.SEED_ADMIN_PASSWORD}\n`)
  } catch (error) {
    console.error(`\nCould not create the admin user: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

await disconnectDatabase()
