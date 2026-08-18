/** Shared, non-secret constants. Anything environment-specific lives in env.ts. */

/** Mirrors the Postgres "UserRole" enum. */
export const UserRole = {
  ADMIN: 'ADMIN',
  EDITOR: 'EDITOR',
  VIEWER: 'VIEWER',
} as const

export type UserRole = (typeof UserRole)[keyof typeof UserRole]

/** Mirrors the Postgres "LeadStatus" enum. */
export const LeadStatus = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  QUALIFIED: 'QUALIFIED',
  WON: 'WON',
  LOST: 'LOST',
  ARCHIVED: 'ARCHIVED',
} as const

export type LeadStatus = (typeof LeadStatus)[keyof typeof LeadStatus]

export const LEAD_STATUSES = Object.values(LeadStatus)

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  GONE: 410,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
} as const

export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS]

export const ROLES = UserRole

/** Roles allowed to mutate content through the admin panel. */
export const CONTENT_MANAGER_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.EDITOR]

export const DEFAULT_SORT_ORDER = 999

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const

/** Ordering used by every "sortable" resource: sort_order, then oldest first. */
export const SORTABLE_ORDER_BY = [
  { column: 'sort_order', ascending: true },
  { column: 'created_at', ascending: true },
]
