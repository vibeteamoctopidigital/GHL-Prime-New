import multer, { MulterError } from 'multer'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import env from '../../config/env.js'
import ApiError from '../utils/ApiError.js'

/**
 * Multipart handling for local-file uploads.
 *
 * Files are kept in memory and streamed straight to Cloudinary — nothing is
 * ever written to the API server's disk, so there is no temp directory to clean
 * up and no path-traversal surface.
 */

/** Raster + vector formats Cloudinary handles as images. */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
])

export const ALLOWED_IMAGE_TYPES = [...ALLOWED_MIME_TYPES]

const storage = multer.memoryStorage()

const uploader = multer({
  storage,
  limits: {
    fileSize: env.maxUploadBytes,
    files: env.MAX_UPLOAD_FILES,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(ApiError.badRequest(`Unsupported file type "${file.mimetype}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`))
      return
    }
    callback(null, true)
  },
})

/** Translates multer's own errors into the API's error envelope. */
function wrap(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (error: unknown) => {
      if (error instanceof MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return next(
            ApiError.badRequest(
              `File is larger than the ${env.effectiveMaxUploadMb}MB limit` +
                (env.isServerless ? '. For larger files use GET /uploads/signature to upload directly to Cloudinary.' : ''),
            ),
          )
        }
        if (error.code === 'LIMIT_FILE_COUNT') {
          return next(ApiError.badRequest(`At most ${env.MAX_UPLOAD_FILES} files can be uploaded at once`))
        }
        if (error.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(ApiError.badRequest(`Unexpected field "${error.field}". Send the file as "file" (or "files" for many).`))
        }
        return next(ApiError.badRequest(error.message))
      }

      return next(error)
    })
  }
}

/** Accepts one file under the field name `file`. */
export const uploadSingleImage = wrap(uploader.single('file'))

/** Accepts up to MAX_UPLOAD_FILES under the field name `files`. */
export const uploadManyImages = wrap(uploader.array('files', env.MAX_UPLOAD_FILES))

export default uploadSingleImage
