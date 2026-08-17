import type { GalleryCategory, GalleryImage } from '@prisma/client'
import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'
import { buildUniqueSlug } from '../../shared/utils/slug.js'
import type { SerializedRow } from '../../types/common.js'

class GalleryCategoryService extends SortableService<GalleryCategory> {
  constructor() {
    super({
      model: prisma.galleryCategory,
      resourceName: 'Gallery category',
      searchableFields: ['name', 'slug'],
      serialize: defaultSerializer,
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

class GalleryImageService extends SortableService<GalleryImage> {
  constructor() {
    super({
      model: prisma.galleryImage,
      resourceName: 'Gallery image',
      searchableFields: ['title'],
      serialize: defaultSerializer,
    })
  }

  /** Images filtered to one category — backs the /gallery tab switching. */
  listByCategory(categoryId: string, { includeUnpublished = false } = {}): Promise<SerializedRow[]> {
    return this.list({
      where: { categoryId, ...(includeUnpublished ? {} : { published: true }) },
    })
  }
}

export const galleryCategoryService = new GalleryCategoryService()
export const galleryImageService = new GalleryImageService()
