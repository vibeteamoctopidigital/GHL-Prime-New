import type { PostgrestFilterBuilder } from '@supabase/postgrest-js'
import supabase from '../../config/supabase.js'
import ApiError from '../utils/ApiError.js'
import { toSnakeCase } from '../serializers/caseTransform.js'
import { buildPaginationMeta } from '../utils/pagination.js'
import type { DeletionResult, PaginatedResult, SerializedRow } from '../../types/common.js'

/**
 * Filter shape used across the services.
 *
 * Keys are snake_case columns compared with equality; `NOT` nests columns to
 * exclude. That covers every query this API makes — anything more exotic
 * belongs in a Postgres function rather than hidden inside a generic layer.
 */
export interface Where {
  [column: string]: unknown
  NOT?: Record<string, unknown>
}

export interface OrderBy {
  column: string
  ascending: boolean
}

export interface BaseServiceOptions {
  /** Table name, e.g. 'blog_posts'. */
  table: string
  resourceName?: string
  defaultOrderBy?: OrderBy[]
  /** PostgREST select string — this is how embeds are expressed. */
  select?: string
  /** Row -> API shape mapper. Rows already arrive snake_case. */
  serialize?: (row: SerializedRow) => SerializedRow
  /** Columns matched by `search` (ILIKE). */
  searchableFields?: readonly string[]
}

export interface ListOptions {
  where?: Where
  orderBy?: OrderBy[]
  select?: string
  search?: string | undefined
  limit?: number
}

export interface PaginatedListOptions extends ListOptions {
  page: number
  limit: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Query = PostgrestFilterBuilder<any, any, any, any, any>

/**
 * Generic data-access layer over a Supabase (PostgREST) table.
 *
 * Rows arrive already snake_case — the same casing the API emits — so unlike
 * the ORM layer this replaced there is no output transform. Input is converted
 * on the way in instead, which is why callers may still pass camelCase.
 */
export class BaseService {
  public readonly table: string
  public readonly resourceName: string
  protected readonly defaultOrderBy: OrderBy[]
  protected readonly selectClause: string
  protected readonly serialize: (row: SerializedRow) => SerializedRow
  protected readonly searchableFields: readonly string[]

  constructor(options: BaseServiceOptions) {
    this.table = options.table
    this.resourceName = options.resourceName ?? 'Resource'
    this.defaultOrderBy = options.defaultOrderBy ?? [{ column: 'created_at', ascending: false }]
    this.selectClause = options.select ?? '*'
    this.serialize = options.serialize ?? ((row) => row)
    this.searchableFields = options.searchableFields ?? []
  }

  /** Turns a PostgREST error into the API's error envelope. */
  protected fail(message: string, error: { message: string; code?: string }): never {
    if (error.code === 'PGRST205') {
      throw ApiError.internal(`Table "${this.table}" does not exist in Supabase.`)
    }
    if (error.code === '23505') throw ApiError.conflict(`${this.resourceName} already exists`)
    if (error.code === '23503') throw ApiError.badRequest('Related record does not exist')
    if (error.code === '23502') throw ApiError.badRequest(`A required field is missing: ${error.message}`)

    throw ApiError.internal(`${message}: ${error.message}`)
  }

  protected applyFilters(query: Query, where: Where = {}): Query {
    let next = query

    for (const [column, value] of Object.entries(where)) {
      if (column === 'NOT') continue
      next = value === null ? next.is(column, null) : next.eq(column, value as never)
    }

    for (const [column, value] of Object.entries(where.NOT ?? {})) {
      next = next.neq(column, value as never)
    }

    return next
  }

  /** Case-insensitive OR match across `searchableFields`. */
  protected applySearch(query: Query, search?: string): Query {
    if (!search || this.searchableFields.length === 0) return query

    // Commas and parentheses would break PostgREST's or() grammar.
    const safe = search.replace(/[,()]/g, ' ').trim()
    if (!safe) return query

    return query.or(this.searchableFields.map((field) => `${field}.ilike.%${safe}%`).join(','))
  }

  protected applyOrder(query: Query, orderBy?: OrderBy[]): Query {
    let next = query
    for (const { column, ascending } of orderBy ?? this.defaultOrderBy) {
      next = next.order(column, { ascending })
    }
    return next
  }

  async list(options: ListOptions = {}): Promise<SerializedRow[]> {
    let query = supabase.from(this.table).select(options.select ?? this.selectClause) as unknown as Query

    query = this.applyFilters(query, options.where)
    query = this.applySearch(query, options.search)
    query = this.applyOrder(query, options.orderBy)
    if (typeof options.limit === 'number') query = query.limit(options.limit)

    const { data, error } = await query
    if (error) this.fail(`Could not list ${this.resourceName}`, error)

    return (data ?? []).map((row: SerializedRow) => this.serialize(row))
  }

  async listPaginated(options: PaginatedListOptions): Promise<PaginatedResult<SerializedRow>> {
    const { page, limit } = options
    const from = (page - 1) * limit

    let query = supabase
      .from(this.table)
      .select(options.select ?? this.selectClause, { count: 'exact' }) as unknown as Query

    query = this.applyFilters(query, options.where)
    query = this.applySearch(query, options.search)
    query = this.applyOrder(query, options.orderBy)

    const { data, error, count } = await query.range(from, from + limit - 1)
    if (error) this.fail(`Could not list ${this.resourceName}`, error)

    return {
      data: (data ?? []).map((row: SerializedRow) => this.serialize(row)),
      meta: buildPaginationMeta({ page, limit, total: count ?? 0 }),
    }
  }

  async findById(id: string, options: { select?: string } = {}): Promise<SerializedRow | null> {
    const { data, error } = await supabase
      .from(this.table)
      .select(options.select ?? this.selectClause)
      .eq('id', id)
      .maybeSingle()

    if (error) this.fail(`Could not load ${this.resourceName}`, error)
    return data ? this.serialize(data as unknown as SerializedRow) : null
  }

  async findByIdOrFail(id: string, options?: { select?: string }): Promise<SerializedRow> {
    const record = await this.findById(id, options)
    if (!record) throw ApiError.notFound(`${this.resourceName} not found`)
    return record
  }

  async findOne(where: Where, options: { select?: string; orderBy?: OrderBy[] } = {}): Promise<SerializedRow | null> {
    let query = supabase.from(this.table).select(options.select ?? this.selectClause) as unknown as Query

    query = this.applyFilters(query, where)
    query = this.applyOrder(query, options.orderBy)

    const { data, error } = await query.limit(1)
    if (error) this.fail(`Could not load ${this.resourceName}`, error)

    const row = (data ?? [])[0] as SerializedRow | undefined
    return row ? this.serialize(row) : null
  }

  async findOneOrFail(where: Where, options?: { select?: string }): Promise<SerializedRow> {
    const record = await this.findOne(where, options)
    if (!record) throw ApiError.notFound(`${this.resourceName} not found`)
    return record
  }

  /** Accepts camelCase or snake_case input; always writes snake_case. */
  protected toColumns(data: Record<string, unknown>): Record<string, unknown> {
    const row = toSnakeCase<Record<string, unknown>>(data)
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))
  }

  async create(data: Record<string, unknown>, options: { select?: string } = {}): Promise<SerializedRow> {
    const { data: created, error } = await supabase
      .from(this.table)
      .insert(this.toColumns(data))
      .select(options.select ?? this.selectClause)
      .single()

    if (error) this.fail(`Could not create ${this.resourceName}`, error)
    return this.serialize(created as unknown as SerializedRow)
  }

  async update(id: string, data: Record<string, unknown>, options: { select?: string } = {}): Promise<SerializedRow> {
    const columns = this.toColumns(data)

    // An empty PATCH would otherwise update zero rows and look like a 404.
    if (Object.keys(columns).length === 0) return this.findByIdOrFail(id, options)

    const { data: updated, error } = await supabase
      .from(this.table)
      .update(columns)
      .eq('id', id)
      .select(options.select ?? this.selectClause)
      .maybeSingle()

    if (error) this.fail(`Could not update ${this.resourceName}`, error)
    if (!updated) throw ApiError.notFound(`${this.resourceName} not found`)

    return this.serialize(updated as unknown as SerializedRow)
  }

  async remove(id: string): Promise<DeletionResult> {
    const { data, error } = await supabase.from(this.table).delete().eq('id', id).select('id').maybeSingle()

    if (error) this.fail(`Could not delete ${this.resourceName}`, error)
    if (!data) throw ApiError.notFound(`${this.resourceName} not found`)

    return { id, deleted: true }
  }

  async count(where: Where = {}): Promise<number> {
    let query = supabase.from(this.table).select('id', { count: 'exact', head: true }) as unknown as Query
    query = this.applyFilters(query, where)

    const { count, error } = await query
    if (error) this.fail(`Could not count ${this.resourceName}`, error)

    return count ?? 0
  }

  async exists(where: Where): Promise<boolean> {
    return (await this.count(where)) > 0
  }

  async ensureExists(id: string): Promise<void> {
    if (!(await this.exists({ id }))) throw ApiError.notFound(`${this.resourceName} not found`)
  }
}

export default BaseService
