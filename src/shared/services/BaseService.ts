import ApiError from '../utils/ApiError.js'
import { toSnakeCase } from '../serializers/caseTransform.js'
import { buildPaginationMeta } from '../utils/pagination.js'
import type { DeletionResult, PaginatedResult, SerializedRow } from '../../types/common.js'

/**
 * Filter shape used across the services.
 *
 * Keys are snake_case columns compared with equality; `NOT` nests columns to
 * exclude. That covers every query this API makes — anything more exotic
 * belongs in a raw query rather than hidden inside a generic layer. This
 * shape is intentionally close to Prisma's own native `where` object (which
 * already accepts exactly `{ column: value, NOT: {...} }`, `null` meaning
 * IS NULL) — that's what makes swapping the implementation underneath this
 * class, from PostgREST to Prisma, possible without touching every caller.
 */
export interface Where {
  [column: string]: unknown
  NOT?: Record<string, unknown>
}

export interface OrderBy {
  column: string
  ascending: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The minimal shape every Prisma model delegate (`prisma.caseStudy`,
 * `prisma.blogPost`, ...) satisfies — just enough surface for this generic
 * layer. Deliberately loose (`any` args/returns), matching this file's own
 * previous generic-over-PostgREST style (`PostgrestFilterBuilder<any,any,...>`)
 * — a truly generic data-access layer can't carry each model's exact typing
 * without becoming one concrete class per table, which is exactly what this
 * class exists to avoid.
 */
export interface PrismaModelDelegate {
  findMany(args?: any): Promise<any[]>
  findUnique(args: any): Promise<any | null>
  findFirst(args?: any): Promise<any | null>
  create(args: any): Promise<any>
  update(args: any): any
  delete(args: any): Promise<any>
  count(args?: any): Promise<number>
}

export interface BaseServiceOptions {
  /** A Prisma model delegate, e.g. `prisma.caseStudy`. */
  model: PrismaModelDelegate
  resourceName?: string
  defaultOrderBy?: OrderBy[]
  /** Prisma `include` shape — relations to eager-load by default. Replaces the old PostgREST embed select string. */
  include?: Record<string, unknown>
  /** Row -> API shape mapper. Rows arrive already snake_case (see the field-naming note in schema.prisma). */
  serialize?: (row: SerializedRow) => SerializedRow
  /** Columns matched by `search` (case-insensitive contains). */
  searchableFields?: readonly string[]
}

export interface ListOptions {
  where?: Where
  orderBy?: OrderBy[]
  /** Column allowlist for this one call, overriding the class's default `include`. Rare — most callers rely on the default. */
  select?: string[]
  search?: string | undefined
  limit?: number
}

export interface PaginatedListOptions extends ListOptions {
  page: number
  limit: number
}

interface PrismaErrorLike {
  code?: string
  message: string
}

function isPrismaError(error: unknown): error is PrismaErrorLike {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

/**
 * Generic data-access layer over a Prisma model delegate.
 *
 * Rows arrive already snake_case — schema.prisma's field names are kept
 * identical to the real Postgres column names rather than camelCased, so
 * there is no output transform here, same as when this sat directly on
 * PostgREST. Input is converted on the way in instead (`toColumns`), which is
 * why callers may still pass camelCase.
 */
export class BaseService {
  public readonly model: PrismaModelDelegate
  public readonly resourceName: string
  protected readonly defaultOrderBy: OrderBy[]
  protected readonly includeClause: Record<string, unknown> | undefined
  protected readonly serialize: (row: SerializedRow) => SerializedRow
  protected readonly searchableFields: readonly string[]

  constructor(options: BaseServiceOptions) {
    this.model = options.model
    this.resourceName = options.resourceName ?? 'Resource'
    this.defaultOrderBy = options.defaultOrderBy ?? [{ column: 'created_at', ascending: false }]
    this.includeClause = options.include
    this.serialize = options.serialize ?? ((row) => row)
    this.searchableFields = options.searchableFields ?? []
  }

  /** Turns a Prisma error into the API's error envelope. */
  protected fail(message: string, error: unknown): never {
    if (isPrismaError(error)) {
      if (error.code === 'P2002') throw ApiError.conflict(`${this.resourceName} already exists`)
      if (error.code === 'P2003') throw ApiError.badRequest('Related record does not exist')
      if (error.code === 'P2011' || error.code === 'P2012') throw ApiError.badRequest(`A required field is missing: ${error.message}`)
      if (error.code === 'P2025') throw ApiError.notFound(`${this.resourceName} not found`)
    }

    const detail = error instanceof Error ? error.message : String(error)
    throw ApiError.internal(`${message}: ${detail}`)
  }

  protected buildWhere(where: Where = {}): Record<string, unknown> {
    return where
  }

  /** Case-insensitive OR-match across `searchableFields`. */
  protected buildSearch(search?: string): Record<string, unknown> | undefined {
    if (!search || this.searchableFields.length === 0) return undefined
    const safe = search.trim()
    if (!safe) return undefined

    return { OR: this.searchableFields.map((field) => ({ [field]: { contains: safe, mode: 'insensitive' } })) }
  }

  /** Combines an explicit `where` with a search clause — ANDed together, since `where` may itself use `OR`. */
  protected combineWhere(where?: Where, search?: string): Record<string, unknown> {
    const baseWhere = this.buildWhere(where)
    const searchWhere = this.buildSearch(search)
    return searchWhere ? { AND: [baseWhere, searchWhere] } : baseWhere
  }

  protected buildOrderBy(orderBy?: OrderBy[]): Record<string, 'asc' | 'desc'>[] {
    return (orderBy ?? this.defaultOrderBy).map(({ column, ascending }) => ({ [column]: ascending ? 'asc' : 'desc' }))
  }

  /** A per-call `select` always wins over the class's default `include` (Prisma disallows combining the two). */
  private selectOrInclude(select?: string[]): Record<string, unknown> {
    if (select) return { select: Object.fromEntries(select.map((column) => [column, true])) }
    if (this.includeClause) return { include: this.includeClause }
    return {}
  }

  async list(options: ListOptions = {}): Promise<SerializedRow[]> {
    const rows = await this.model.findMany({
      where: this.combineWhere(options.where, options.search),
      orderBy: this.buildOrderBy(options.orderBy),
      ...(typeof options.limit === 'number' ? { take: options.limit } : {}),
      ...this.selectOrInclude(options.select),
    })

    return rows.map((row: SerializedRow) => this.serialize(row))
  }

  async listPaginated(options: PaginatedListOptions): Promise<PaginatedResult<SerializedRow>> {
    const { page, limit } = options
    const where = this.combineWhere(options.where, options.search)
    const orderBy = this.buildOrderBy(options.orderBy)
    const skip = (page - 1) * limit

    const [rows, total] = await Promise.all([
      this.model.findMany({ where, orderBy, skip, take: limit, ...this.selectOrInclude(options.select) }),
      this.model.count({ where }),
    ])

    return {
      data: rows.map((row: SerializedRow) => this.serialize(row)),
      meta: buildPaginationMeta({ page, limit, total }),
    }
  }

  async findById(id: string, options: { select?: string[] } = {}): Promise<SerializedRow | null> {
    const row = await this.model.findUnique({ where: { id }, ...this.selectOrInclude(options.select) })
    return row ? this.serialize(row) : null
  }

  async findByIdOrFail(id: string, options?: { select?: string[] }): Promise<SerializedRow> {
    const record = await this.findById(id, options)
    if (!record) throw ApiError.notFound(`${this.resourceName} not found`)
    return record
  }

  async findOne(where: Where, options: { select?: string[]; orderBy?: OrderBy[] } = {}): Promise<SerializedRow | null> {
    const row = await this.model.findFirst({
      where: this.buildWhere(where),
      orderBy: this.buildOrderBy(options.orderBy),
      ...this.selectOrInclude(options.select),
    })

    return row ? this.serialize(row) : null
  }

  async findOneOrFail(where: Where, options?: { select?: string[] }): Promise<SerializedRow> {
    const record = await this.findOne(where, options)
    if (!record) throw ApiError.notFound(`${this.resourceName} not found`)
    return record
  }

  /** Accepts camelCase or snake_case input; always writes snake_case, matching schema.prisma's field names. */
  protected toColumns(data: Record<string, unknown>): Record<string, unknown> {
    const row = toSnakeCase<Record<string, unknown>>(data)
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
  }

  async create(data: Record<string, unknown>, options: { select?: string[] } = {}): Promise<SerializedRow> {
    try {
      const created = await this.model.create({ data: this.toColumns(data), ...this.selectOrInclude(options.select) })
      return this.serialize(created)
    } catch (error) {
      this.fail(`Could not create ${this.resourceName}`, error)
    }
  }

  async update(id: string, data: Record<string, unknown>, options: { select?: string[] } = {}): Promise<SerializedRow> {
    const columns = this.toColumns(data)

    // An empty PATCH would otherwise ask Prisma to update zero fields, which it rejects.
    if (Object.keys(columns).length === 0) return this.findByIdOrFail(id, options)

    try {
      const updated = await this.model.update({ where: { id }, data: columns, ...this.selectOrInclude(options.select) })
      return this.serialize(updated)
    } catch (error) {
      // Unlike PostgREST (which returned no error, just no row, for a
      // missing id), Prisma throws P2025 — fail() already maps that to the
      // same 404 this method returned before.
      this.fail(`Could not update ${this.resourceName}`, error)
    }
  }

  async remove(id: string): Promise<DeletionResult> {
    try {
      await this.model.delete({ where: { id } })
      return { id, deleted: true }
    } catch (error) {
      this.fail(`Could not delete ${this.resourceName}`, error)
    }
  }

  async count(where: Where = {}): Promise<number> {
    return this.model.count({ where: this.buildWhere(where) })
  }

  async exists(where: Where): Promise<boolean> {
    return (await this.count(where)) > 0
  }

  async ensureExists(id: string): Promise<void> {
    if (!(await this.exists({ id }))) throw ApiError.notFound(`${this.resourceName} not found`)
  }
}

export default BaseService
