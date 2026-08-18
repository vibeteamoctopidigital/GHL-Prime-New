import SortableService from '../../shared/services/SortableService.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import type { SerializedRow } from '../../types/common.js'

class GalleryCategoryService extends SortableService {
  constructor() {
    super({
      table: 'gallery_categories',
      resourceName: 'Gallery category',
      searchableFields: ['name', 'slug'],
    })
  }

  /** Derives a unique slug from the name when the client does not supply one. */
  override async create(data: Record<string, unknown>): Promise<SerializedRow> {
    const slug =
      (data['slug'] as string | undefined) ||
      (await buildUniqueSlug(data['name'], (candidate) => this.exists({ slug: candidate }), 'category'))

    return super.create({ ...data, slug })
  }

  override async update(id: string, data: Record<string, unknown>): Promise<SerializedRow> {
    const slug = data['slug'] as string | undefined

    if (slug && (await this.exists({ slug, NOT: { id } }))) {
      return super.update(id, {
        ...data,
        slug: await buildUniqueSlug(slug, (candidate) => this.exists({ slug: candidate, NOT: { id } })),
      })
    }

    return super.update(id, data)
  }

  findBySlug(slug: string): Promise<SerializedRow> {
    return this.findOneOrFail({ slug })
  }
}

class GalleryImageService extends SortableService {
  constructor() {
    super({
      table: 'gallery_images',
      resourceName: 'Gallery image',
      searchableFields: ['title'],
    })
  }

  /** Images filtered to one category — backs the /gallery tab switching. */
  listByCategory(categoryId: string, { includeUnpublished = false } = {}): Promise<SerializedRow[]> {
    return this.list({
      where: { category_id: categoryId, ...(includeUnpublished ? {} : { published: true }) },
    })
  }
}

export const galleryCategoryService = new GalleryCategoryService()
export const galleryImageService = new GalleryImageService()
