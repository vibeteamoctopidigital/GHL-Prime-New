import BaseService, { type BaseServiceOptions } from './BaseService.js'
import ApiError from '../utils/ApiError.js'
import logger from '../utils/logger.js'
import env from '../../config/env.js'
import { LEAD_STATUSES, type LeadStatus } from '../../config/constants.js'
import type { PaginatedResult, SerializedRow } from '../../types/common.js'

export interface LeadServiceOptions extends BaseServiceOptions {
  /** CRM webhook this lead type is forwarded to. Empty disables forwarding. */
  webhookUrl?: string
}

export interface SpamSignals {
  /** Honeypot field — real users never see it, so any value means a bot. */
  website?: string | undefined
  /** Epoch ms when the form was first rendered. */
  formStartedAt?: number | undefined
}

export interface WebhookResult {
  forwarded: boolean
  reason?: string
}

export interface LeadListOptions {
  page: number
  limit: number
  search?: string | undefined
  status?: LeadStatus | undefined
}

/**
 * Shared behaviour for public lead-capture forms: spam filtering, persistence,
 * CRM webhook forwarding, and an admin inbox.
 */
export class LeadService extends BaseService {
  protected readonly webhookUrl: string

  constructor({ webhookUrl = '', ...options }: LeadServiceOptions) {
    super({ defaultOrderBy: [{ column: 'submitted_at', ascending: false }], ...options })
    this.webhookUrl = webhookUrl
  }

  /**
   * Two spam signals ported from the old serverless handler:
   *   1. `website` is a honeypot — real users never fill it.
   *   2. A form completed faster than CONTACT_MIN_FILL_MS is almost certainly a bot.
   * Callers return "ok" either way, so bots get no feedback.
   */
  isSpam({ website, formStartedAt }: SpamSignals): boolean {
    if (website) return true

    const startedAt = Number(formStartedAt ?? 0)
    if (!startedAt) return false

    const elapsedMs = Date.now() - startedAt
    return elapsedMs > 0 && elapsedMs < env.CONTACT_MIN_FILL_MS
  }

  /** Forwards a payload to the CRM webhook. Never throws — logs and reports. */
  async forwardToWebhook(payload: Record<string, unknown>): Promise<WebhookResult> {
    if (!this.webhookUrl) return { forwarded: false, reason: 'no webhook configured' }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        logger.warn(`${this.resourceName} webhook responded ${response.status}`)
        return { forwarded: false, reason: `webhook responded ${response.status}` }
      }

      return { forwarded: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error'
      logger.warn(`${this.resourceName} webhook request failed:`, reason)
      return { forwarded: false, reason }
    }
  }

  /**
   * Saves the lead, then forwards it — in that order, so a webhook outage can
   * never lose a submission.
   */
  protected async persistAndForward(
    row: Record<string, unknown>,
    webhookPayload: Record<string, unknown>,
  ): Promise<SerializedRow> {
    const created = await this.create(row)
    const result = await this.forwardToWebhook(webhookPayload)

    if (this.webhookUrl && !result.forwarded) {
      throw ApiError.badGateway('Your message was saved but could not be delivered. Our team has been notified.')
    }

    return created
  }

  /** Paginated inbox for the admin panel, filterable by status. */
  listLeads({ page, limit, search, status }: LeadListOptions): Promise<PaginatedResult<SerializedRow>> {
    return this.listPaginated({ page, limit, search, where: status ? { status } : {} })
  }

  updateStatus(id: string, status: LeadStatus, notes?: string | null): Promise<SerializedRow> {
    return this.update(id, { status, ...(notes !== undefined ? { notes } : {}) })
  }

  /** Counts per status, for the admin dashboard summary tiles. */
  async statusCounts(): Promise<Record<string, number>> {
    const counts = await Promise.all(LEAD_STATUSES.map((status) => this.count({ status })))
    const total = await this.count()

    const result: Record<string, number> = { total }
    LEAD_STATUSES.forEach((status, index) => {
      result[status.toLowerCase()] = counts[index] ?? 0
    })

    return result
  }
}

export default LeadService
