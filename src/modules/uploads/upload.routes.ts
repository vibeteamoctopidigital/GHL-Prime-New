import { Router } from 'express'
import { z } from 'zod'
import authenticate from '../../shared/middleware/authenticate.js'
import { authorizeContentManager } from '../../shared/middleware/authorize.js'
import validate from '../../shared/middleware/validate.js'
import { ALLOWED_IMAGE_TYPES, uploadManyImages, uploadSingleImage } from '../../shared/middleware/upload.js'
import asyncHandler from '../../shared/utils/asyncHandler.js'
import ApiError from '../../shared/utils/ApiError.js'
import { sendCreated, sendOk } from '../../shared/utils/ApiResponse.js'
import { idParamSchema, paginationQuerySchema } from '../../shared/validators/common.validators.js'
import createModuleIndex from '../../shared/factories/createModuleIndex.js'
import uploadService from './upload.service.js'

const router = Router()

/** Optional metadata sent alongside the file as multipart text fields. */
const uploadMetaSchema = z.object({
  folder: z.string().trim().max(160).optional(),
  alt: z.string().trim().max(300).optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined
      const list = Array.isArray(value) ? value : value.split(',')
      return list.map((tag) => tag.trim()).filter(Boolean)
    }),
})

type UploadMeta = z.infer<typeof uploadMetaSchema>

const signatureQuerySchema = z.object({ folder: z.string().trim().max(160).optional() }).passthrough()

/**
 * GET /uploads/status — lets the admin UI hide the file picker (and explain
 * why) before anyone tries to upload. Public: it exposes no secrets.
 */
router.get('/status', (_req, res) => {
  sendOk(res, { ...uploadService.status(), allowed_types: ALLOWED_IMAGE_TYPES }, 'Upload configuration retrieved')
})

/** GET /uploads — lists what lives under this prefix. Public, like /status. */
router.get(
  '/',
  createModuleIndex('/uploads', [
    { method: 'GET', path: '/status', description: 'Is uploading configured, and the limits' },
    { method: 'POST', path: '/image', description: 'Upload one image, field "file" (auth)' },
    { method: 'POST', path: '/images', description: 'Upload several, field "files" (auth)' },
    { method: 'GET', path: '/library', description: 'Media library, paginated (auth)' },
    { method: 'GET', path: '/signature', description: 'Signature for browser-direct upload (auth)' },
    { method: 'DELETE', path: '/:id', description: 'Delete by media-asset id (auth)' },
    { method: 'DELETE', path: '/public-id/<folder>/<name>', description: 'Delete by Cloudinary public_id (auth)' },
  ]),
)

// Everything below requires a content-manager session.
router.use(authenticate, authorizeContentManager)

/** POST /uploads/image — multipart/form-data, field name `file`. */
router.post(
  '/image',
  uploadSingleImage,
  validate({ body: uploadMetaSchema }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file received. Send multipart/form-data with a "file" field.')

    const meta = req.body as UploadMeta

    const data = await uploadService.uploadImage(
      { buffer: req.file.buffer, originalName: req.file.originalname, mimeType: req.file.mimetype },
      { folder: meta.folder, alt: meta.alt, tags: meta.tags, uploadedById: req.user?.id },
    )

    return sendCreated(res, { data, message: 'Image uploaded successfully' })
  }),
)

/** POST /uploads/images — multipart/form-data, field name `files`. */
router.post(
  '/images',
  uploadManyImages,
  validate({ body: uploadMetaSchema }),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) throw ApiError.badRequest('No files received. Send multipart/form-data with a "files" field.')

    const meta = req.body as UploadMeta

    const data = await uploadService.uploadImages(
      files.map((file) => ({ buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype })),
      { folder: meta.folder, alt: meta.alt, tags: meta.tags, uploadedById: req.user?.id },
    )

    return sendCreated(res, { data, message: `${data.uploaded.length} of ${files.length} images uploaded` })
  }),
)

/** GET /uploads/signature — for signed browser-direct uploads of large files. */
router.get(
  '/signature',
  validate({ query: signatureQuerySchema }),
  asyncHandler(async (req, res) => {
    const data = uploadService.createUploadSignature(req.query['folder'] as string | undefined)
    return sendOk(res, data, 'Upload signature created')
  }),
)

/** GET /uploads/library — the media library. */
router.get(
  '/library',
  validate({ query: paginationQuerySchema }),
  asyncHandler(async (req, res) => {
    const { page, limit, search } = req.query as unknown as { page: number; limit: number; search?: string }
    const { data, meta } = await uploadService.listAssets({ page, limit, search })
    return sendOk(res, data, 'Media assets retrieved', meta)
  }),
)

/** DELETE /uploads/:id — by our record id. Removes the Cloudinary asset too. */
router.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const data = await uploadService.destroyById(req.params['id'] as string)
    return sendOk(res, data, 'Image deleted successfully')
  }),
)

/**
 * DELETE /uploads/public-id/<folder>/<name> — by Cloudinary public_id.
 * Wildcard-matched because a public_id legitimately contains slashes.
 */
router.delete(
  '/public-id/*',
  asyncHandler(async (req, res) => {
    const params = req.params as unknown as Record<string, string>
    const publicId = params['0']?.trim()

    if (!publicId) throw ApiError.badRequest('A Cloudinary public_id is required')

    const data = await uploadService.destroyByPublicId(publicId)
    return sendOk(res, data, 'Image deleted successfully')
  }),
)

export default router
