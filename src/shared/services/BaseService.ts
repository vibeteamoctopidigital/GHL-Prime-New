import ApiError from '../utils/ApiError.js'
import { pickDefined } from '../utils/object.js'
import { buildPaginationMeta } from '../utils/pagination.js'
import type { DeletionResult, PaginatedResult, PrismaDelegate, SerializedRow } from '../../types/common.js'

export type WhereInput = Record<string, unknown>
export type OrderByInput = Record<string, unknown> | readonly Record<string, unknown>[]
export type IncludeInput = Record<string, unknown>

export interface BaseServiceOptions<TRow> {
  /** The Prisma delegate this service wraps, e.g. `prisma.blogPost`. */
  model: PrismaDelegate<TRow>
  /** Human label used in error messages. */
  resourceName?: string
  defaultOrderBy?: OrderByInput
  defaultInclude?: IncludeInput | undefined
  /** Row -> API shape mapper. */
  serialize?: (row: TRow) => SerializedRow
  /** Fields matched by the `search` option. */
  searchableFields?: readonly string[]
}

export interface ListOptions {
  where?: WhereInput
  orderBy?: OrderByInput
  include?: IncludeInput
  select?: Record<string, unknown>
  search?: string | undefined
  skip?: number
  take?: number
}

export interface PaginatedListOptions extends ListOptions {
  page: number
  limit: number
}

/**
 * Generic data-access layer over a Prisma model.
 *
 * Every resource in this API gets `list / findById / create / update / remove /
 * count / exists` for free by extending this class; modules only write the
 * behaviour that is genuinely specific to them (slug handling, relation
 * syncing, publish rules).
 */
export class BaseService<TRow extends { id: string }> {
  protected readonly model: PrismaDelegate<TRow>
  public readonly resourceName: string
  protected readonly defaultOrderBy: OrderByInput
  protected readonly defaultInclude: IncludeInput | undefined
  protected readonly serialize: (row: TRow) => SerializedRow
  protected readonly searchableFields: readonly string[]

  constructor(options: BaseServiceOptions<TRow>) {
    this.model = options.model
    this.resourceName = options.resourceName ?? 'Resource'
    this.defaultOrderBy = options.defaultOrderBy ?? { createdAt: 'desc' }
    this.defaultInclude = options.defaultInclude
    this.serialize = options.serialize ?? ((row) => row as unknown as SerializedRow)
    this.searchableFields = options.searchableFields ?? []
  }

  /** Maps a list of rows through the configured serializer. */
  protected presentMany(rows: TRow[]): SerializedRow[] {
    return rows.map((row) => this.serialize(row))
  }

  /** Maps one row (or null) through the configured serializer. */
  protected presentOne(row: TRow | null): SerializedRow | null {
    return row === null ? null : this.serialize(row)
  }

  /** Case-insensitive OR-match across `searchableFields`. */
  protected buildSearchFilter(search?: string): WhereInput | null {
    if (!search || this.searchableFields.length === 0) return null

    return {
      OR: this.searchableFields.map((field) => ({ [field]: { contains: search, mode: 'insensitive' } })),
    }
  }

  /** Merges the caller's `where` with the search filter. */
  protected resolveWhere(where: WhereInput = {}, search?: string): WhereInput {
    const searchFilter = this.buildSearchFilter(search)
    return searchFilter ? { AND: [where, searchFilter] } : where
  }

  /** Builds the include/select portion of a query — the two are exclusive in Prisma. */
  protected resolveProjection(include?: IncludeInput, select?: Record<string, unknown>): Record<string, unknown> {
    if (select) return { select }
    const resolved = include ?? this.defaultInclude
    return resolved ? { include: resolved } : {}
  }

  async list(options: ListOptions = {}): Promise<SerializedRow[]> {
    const { where = {}, orderBy, include, select, search, skip, take } = options

    const rows = await this.model.findMany({
      where: this.resolveWhere(where, search),
      orderBy: orderBy ?? this.defaultOrderBy,
      ...this.resolveProjection(include, select),
      ...(typeof skip === 'number' ? { skip } : {}),
      ...(typeof take === 'number' ? { take } : {}),
    })

    return this.presentMany(rows)
  }

  /** Same as `list`, but also returns pagination metadata. */
  async listPaginated(options: PaginatedListOptions): Promise<PaginatedResult<SerializedRow>> {
    const { where = {}, orderBy, include, select, search, page, limit } = options
    const finalWhere = this.resolveWhere(where, search)

    const [rows, total] = await Promise.all([
      this.model.findMany({
        where: finalWhere,
        orderBy: orderBy ?? this.defaultOrderBy,
        ...this.resolveProjection(include, select),
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.model.count({ where: finalWhere }),
    ])

    return { data: this.presentMany(rows), meta: buildPaginationMeta({ page, limit, total }) }
  }

  async findById(
    id: string,
    options: { include?: IncludeInput; select?: Record<string, unknown> } = {},
  ): Promise<SerializedRow | null> {
    const row = await this.model.findUnique({
      where: { id },
      ...this.resolveProjection(options.include, options.select),
    })

    return this.presentOne(row)
  }

  /** Same as `findById` but throws a 404 instead of returning null. */
  async findByIdOrFail(id: string, options?: { include?: IncludeInput }): Promise<SerializedRow> {
    const record = await this.findById(id, options)
    if (!record) throw ApiError.notFound(`${this.resourceName} not found`)
    return record
  }

  async findOne(
    where: WhereInput,
    options: { include?: IncludeInput; orderBy?: OrderByInput } = {},
  ): Promise<SerializedRow | null> {
    const row = await this.model.findFirst({
      where,
      orderBy: options.orderBy ?? this.defaultOrderBy,
      ...this.resolveProjection(options.include),
    })

    return this.presentOne(row)
  }

  async findOneOrFail(where: WhereInput, options?: { include?: IncludeInput }): Promise<SerializedRow> {
    const record = await this.findOne(where, options)
    if (!record) throw ApiError.notFound(`${this.resourceName} not found`)
    return record
  }

  async create(data: Record<string, unknown>, options: { include?: IncludeInput } = {}): Promise<SerializedRow> {
    const created = await this.model.create({
      data: pickDefined(data),
      ...this.resolveProjection(options.include),
    })

    return this.serialize(created)
  }

  async update(
    id: string,
    data: Record<string, unknown>,
    options: { include?: IncludeInput } = {},
  ): Promise<SerializedRow> {
    await this.ensureExists(id)

    const updated = await this.model.update({
      where: { id },
      data: pickDefined(data),
      ...this.resolveProjection(options.include),
    })

    return this.serialize(updated)
  }

  async remove(id: string): Promise<DeletionResult> {
    await this.ensureExists(id)
    await this.model.delete({ where: { id } })
    return { id, deleted: true }
  }

  async count(where: WhereInput = {}): Promise<number> {
    return this.model.count({ where })
  }

  async exists(where: WhereInput): Promise<boolean> {
    return (await this.model.count({ where, take: 1 })) > 0
  }

  /** Throws 404 unless a row with this id exists. */
  async ensureExists(id: string): Promise<void> {
    if (!(await this.exists({ id }))) {
      throw ApiError.notFound(`${this.resourceName} not found`)
    }
  }
}

export default BaseService
