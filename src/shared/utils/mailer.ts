import nodemailer, { type Transporter } from 'nodemailer'
import env from '../../config/env.js'
import logger from './logger.js'

/**
 * Admin alert emails (Auto Blog run failures, no-provider outages, AI-checker
 * rejections). Optional infra, same pattern as Cloudinary: the app must boot
 * and keep working without SMTP configured — sendAdminAlert() just logs a
 * warning and no-ops instead of throwing.
 *
 * Does NOT cover the server itself going offline — nothing running inside a
 * dead process can send an email about it. That needs an external uptime
 * monitor hitting GET /api/health; see docs/BLOG_AI.md.
 */

let transporter: Transporter | null = null

function getTransporter(): Transporter | null {
  if (!env.hasSmtp) return null
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  })

  return transporter
}

export interface AdminAlertOptions {
  subject: string
  text: string
}

export async function sendAdminAlert(options: AdminAlertOptions): Promise<void> {
  const client = getTransporter()

  if (!client || env.adminAlertEmails.length === 0) {
    logger.warn(`Admin alert email skipped (SMTP not configured): ${options.subject}`)
    return
  }

  try {
    await client.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to: env.adminAlertEmails.join(', '),
      subject: `[GHL Prime Auto Blog] ${options.subject}`,
      text: options.text,
    })
  } catch (error) {
    // An alerting failure must never crash the caller (a blog generation run) —
    // log it and move on, this is best-effort by nature.
    logger.error('Could not send admin alert email:', error instanceof Error ? error.message : error)
  }
}

export default sendAdminAlert
