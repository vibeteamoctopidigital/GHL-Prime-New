import type { UploadApiOptions, UploadApiResponse } from 'cloudinary'
import supabase from '../../config/supabase.js'
import env from '../../config/env.js'
import { getCloudinary } from '../../config/cloudinary.js'
import BaseService from '../../shared/services/BaseService.js'
import ApiError from '../../shared/utils/ApiError.js'
import logger from '../../shared/utils/logger.js'
import type { PaginatedResult, SerializedRow } from '../../types/common.js'

export interface UploadInput {
  buffer: Buffer
  originalName?: string | undefined
  mimeType?: string | undefined
}

export interface UploadOptions {
  folder?: string | undefined
  alt?: string | undefined
  tags?: string[] | undefined
  uploadedById?: string | undefined
}

/**
 * 503, not 500: nothing is broken and the caller did nothing wrong — the
 * operator simply has not supplied credentials yet.
 */
const notConfigured = (): ApiError =>
  ApiError.serviceUnavailable(
    'Image uploads are not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
    { code: 'CLOUDINARY_NOT_CONFIGURED' },
  )

/**
 * Turns a Cloudinary SDK error into something actionable.
 *
 * The SDK often collapses a rejected request into "Server returned unexpected
 * status code - 403" and drops the response body, which hides the real cause.
 * The most common one by far is an API key issued without upload permission, so
 * that case gets named explicitly instead of leaving a bare status code.
 */
function describeCloudinaryError(error: unknown): ApiError {
  const raw = error as { message?: string; http_code?: number; error?: { message?: string } }
  const status = raw?.http_code
  const detail = raw?.error?.message ?? raw?.message ?? 'unknown error'

  if (status === 401 || status === 403 || /403|forbidden|permission/i.test(detail)) {
    return ApiError.badGateway(
      'Cloudinary rejected the upload (HTTP 403). The API key is valid but lacks upload permission — ' +
        'in the Cloudinary console open Settings → API Keys and grant this key the "create" permission, ' +
        `or use your account's primary key. Cloudinary said: ${detail}`,
      { code: 'CLOUDINARY_FORBIDDEN' },
    )
  }

  return ApiError.badGateway(`Cloudinary upload failed: ${detail}`, {
    code: 'CLOUDINARY_UPLOAD_FAILED',
    ...(status ? { details: { http_code: status } } : {}),
  })
}

class UploadService extends BaseService {
  constructor() {
    super({
      table: 'media_assets',
      resourceName: 'Media asset',
      defaultOrderBy: [{ column: 'created_at', ascending: false }],
      searchableFields: ['original_filename', 'alt', 'public_id'],
    })
  }

  get isConfigured(): boolean {
    return env.hasCloudinary
  }

  /**
   * Streams an in-memory buffer to Cloudinary.
   *
   * `upload_stream` is used rather than a base64 data URI so a large file is
   * not duplicated in memory as a ~33%-larger string.
   */
  private uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<UploadApiResponse> {
    const cloudinary = getCloudinary()
    if (!cloudinary) throw notConfigured()

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error) {
          reject(describeCloudinaryError(error))
          return
        }
        if (!result) {
          reject(ApiError.badGateway('Cloudinary returned no result'))
          return
        }
        resolve(result)
      })

      stream.end(buffer)
    })
  }

  /** Uploads one image and records it in `media_assets`. */
  async uploadImage(file: UploadInput, options: UploadOptions = {}): Promise<SerializedRow> {
    if (!this.isConfigured) throw notConfigured()

    const folder = options.folder?.trim() || env.CLOUDINARY_UPLOAD_FOLDER

    const result = await this.uploadBuffer(file.buffer, {
      folder,
      resource_type: 'image',
      // Let Cloudinary pick the best codec/quality per requesting browser.
      fetch_format: 'auto',
      quality: 'auto',
      ...(options.tags?.length ? { tags: options.tags } : {}),
    })

    const record = {
      url: result.url,
      secureUrl: result.secure_url,
      format: result.format ?? null,
      resourceType: result.resource_type ?? null,
      width: result.width ?? null,
      height: result.height ?? null,
      bytes: result.bytes ?? null,
      folder: result.folder ?? folder,
      originalFilename: file.originalName ?? null,
      alt: options.alt ?? null,
      tags: options.tags ?? [],
      uploadedById: options.uploadedById ?? null,
    }

    // Upsert, not insert: Cloudinary returns the existing public_id when an
    // asset is overwritten, and that must refresh the row rather than collide
    // on the unique index.
    const { data: asset, error } = await supabase
      .from('media_assets')
      .upsert(this.toColumns({ publicId: result.public_id, ...record }), { onConflict: 'public_id' })
      .select('*')
      .single()

    if (error) this.fail('Could not record the uploaded image', error)

    logger.info(`Uploaded image ${result.public_id} (${result.bytes} bytes)`)
    return this.serialize(asset as SerializedRow)
  }

  /** Uploads several images. One failure does not discard the successes. */
  async uploadImages(files: UploadInput[], options: UploadOptions = {}): Promise<{
    uploaded: SerializedRow[]
    failed: { filename: string; reason: string }[]
  }> {
    if (!this.isConfigured) throw notConfigured()

    const settled = await Promise.allSettled(files.map((file) => this.uploadImage(file, options)))

    const uploaded: SerializedRow[] = []
    const failed: { filename: string; reason: string }[] = []

    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        uploaded.push(outcome.value)
      } else {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : 'Upload failed'
        failed.push({ filename: files[index]?.originalName ?? `file-${index}`, reason })
      }
    })

    // Nothing succeeded: surface the real failure instead of reporting a
    // "201 Created, 0 of N uploaded", which reads as success to a client.
    if (uploaded.length === 0 && failed.length > 0) {
      const first = settled.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult | undefined
      if (first?.reason instanceof ApiError) throw first.reason
      throw ApiError.badGateway(`All ${failed.length} uploads failed: ${failed[0]?.reason ?? 'unknown error'}`)
    }

    return { uploaded, failed }
  }

  /**
   * Removes the remote asset first, then the local record — so a Cloudinary
   * failure leaves the row in place rather than silently orphaning the file.
   */
  async destroyByPublicId(publicId: string): Promise<{ public_id: string; deleted: true }> {
    const cloudinary = getCloudinary()
    if (!cloudinary) throw notConfigured()

    const result = (await cloudinary.uploader.destroy(publicId, { resource_type: 'image' })) as { result?: string }

    // 'not found' is fine — the goal is that it no longer exists.
    if (result.result !== 'ok' && result.result !== 'not found') {
      throw ApiError.badGateway(`Cloudinary delete failed: ${result.result ?? 'unknown error'}`)
    }

    const { error: deleteError } = await supabase.from('media_assets').delete().eq('public_id', publicId)
    if (deleteError) this.fail('Could not remove the media record', deleteError)

    logger.info(`Deleted image ${publicId}`)
    return { public_id: publicId, deleted: true }
  }

  /** Deletes by our own record id, resolving the public_id first. */
  async destroyById(id: string): Promise<{ public_id: string; deleted: true }> {
    const asset = await this.findByIdOrFail(id)
    return this.destroyByPublicId(asset['public_id'] as string)
  }

  /** The media library listing for the admin panel. */
  listAssets({ page, limit, search }: { page: number; limit: number; search?: string | undefined }): Promise<PaginatedResult<SerializedRow>> {
    return this.listPaginated({ page, limit, search })
  }

  /**
   * Signature for a signed browser-direct upload, letting very large files skip
   * this server entirely while staying authenticated.
   */
  createUploadSignature(folder?: string): {
    signature: string
    timestamp: number
    api_key: string
    cloud_name: string
    folder: string
  } {
    const cloudinary = getCloudinary()
    if (!cloudinary) throw notConfigured()

    const config = cloudinary.config()
    if (!config.api_secret || !config.api_key || !config.cloud_name) throw notConfigured()

    const timestamp = Math.round(Date.now() / 1000)
    const targetFolder = folder?.trim() || env.CLOUDINARY_UPLOAD_FOLDER

    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder: targetFolder },
      config.api_secret,
    )

    return { signature, timestamp, api_key: config.api_key, cloud_name: config.cloud_name, folder: targetFolder }
  }

  /** What the admin UI needs to render (or disable) its file picker. */
  status(): { configured: boolean; folder: string; max_file_size_mb: number; max_files: number } {
    return {
      configured: this.isConfigured,
      folder: env.CLOUDINARY_UPLOAD_FOLDER,
      max_file_size_mb: env.effectiveMaxUploadMb,
      max_files: env.MAX_UPLOAD_FILES,
    }
  }
}

export const uploadService = new UploadService()
export default uploadService
