import { PAGINATION } from '../../config/constants.js'
import type { PaginationInput, PaginationMeta, PaginationParams } from '../../types/common.js'

/**
 * Reads `page`/`limit` from a query string and turns them into Prisma
 * `skip`/`take`. Invalid or out-of-range values fall back to the defaults
 * rather than erroring, so a malformed URL never breaks a listing.
 */
export function getPagination(query: PaginationInput = {}): PaginationParams {
  const rawPage = Number.parseInt(String(query.page), 10)
  const rawLimit = Number.parseInt(String(query.limit), 10)

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : PAGINATION.DEFAULT_PAGE
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, PAGINATION.MAX_LIMIT) : PAGINATION.DEFAULT_LIMIT

  return { page, limit, skip: (page - 1) * limit, take: limit }
}

export function buildPaginationMeta({ page, limit, total }: { page: number; limit: number; total: number }): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0

  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  }
}

export default { getPagination, buildPaginationMeta }
