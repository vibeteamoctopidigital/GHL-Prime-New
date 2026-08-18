import type { UserRole } from '../config/constants.js'

/** The trimmed user record attached to `req.user` by the auth middleware. */
export interface AuthenticatedUser {
  id: string
  email: string
  fullName: string | null
  role: UserRole
  isActive: boolean
}

/** Anything JSON-serialisable. Used where a row is passed to a serializer. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** A row as it leaves the API: snake_case keys, arbitrary values. */
export type SerializedRow = Record<string, unknown>

export interface PaginationInput {
  page?: number | string | undefined
  limit?: number | string | undefined
}

export interface PaginationParams {
  page: number
  limit: number
  skip: number
  take: number
}

export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

export interface PaginatedResult<T> {
  data: T[]
  meta: PaginationMeta
}

/** Standard success envelope returned by every endpoint. */
export interface ApiSuccessBody<T = unknown> {
  success: true
  message: string
  data: T
  meta?: PaginationMeta
}

export interface ApiErrorBody {
  success: false
  message: string
  errors?: unknown
}

/** A field-level validation failure, as reported by the validate middleware. */
export interface ValidationIssue {
  field: string
  message: string
}

/** One entry in a PATCH /reorder payload. */
export interface ReorderItem {
  id: string
  sortOrder: number
}

/** Result of a delete, returned to the client. */
export interface DeletionResult {
  id: string
  deleted: true
}
