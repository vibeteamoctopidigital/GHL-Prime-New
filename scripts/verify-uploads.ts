/**
 * Verifies the Cloudinary upload path WITHOUT real credentials, by stubbing the
 * SDK's network calls. Proves the wiring — stream upload, media_assets record,
 * snake_case serialization, delete-remote-then-local — so the module is known
 * good before real keys are added.
 *
 *   npx tsx scripts/verify-uploads.ts
 */

// Fake credentials must be in place before env.ts is imported, so that
// env.hasCloudinary is true for this run.
process.env['CLOUDINARY_CLOUD_NAME'] = 'test-cloud'
process.env['CLOUDINARY_API_KEY'] = '123456789012345'
process.env['CLOUDINARY_API_SECRET'] = 'test-secret-value'

import { PassThrough } from 'node:stream'
import { v2 as cloudinary } from 'cloudinary'

let passed = 0
let failed = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// --- Stub the two SDK calls that would hit the network ---------------------
const uploadCalls: Record<string, unknown>[] = []
const destroyCalls: string[] = []
let assetCounter = 0

/**
 * Cloudinary's real return type is an UploadStream (a Transform). A PassThrough
 * is one, so the stub is structurally the same thing the service writes to.
 */
function stubUploadStream(options: Record<string, unknown>, callback: (error: unknown, result: unknown) => void): PassThrough {
  uploadCalls.push(options)

  // Real Cloudinary auto-generates a distinct public_id per upload.
  assetCounter += 1
  const assetId = assetCounter

  const stream = new PassThrough()
  const chunks: Buffer[] = []

  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  stream.on('end', () => {
    callback(undefined, {
      public_id: `${String(options['folder'])}/stubbed-asset-${assetId}`,
      url: 'http://res.cloudinary.com/test-cloud/image/upload/v1/stubbed-asset.png',
      secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/stubbed-asset.png',
      format: 'png',
      resource_type: 'image',
      width: 1,
      height: 1,
      bytes: Buffer.concat(chunks).length,
      folder: options['folder'],
    })
  })

  return stream
}

cloudinary.uploader.upload_stream = stubUploadStream as unknown as typeof cloudinary.uploader.upload_stream

cloudinary.uploader.destroy = (async (publicId: string) => {
  destroyCalls.push(publicId)
  return { result: 'ok' }
}) as unknown as typeof cloudinary.uploader.destroy

// Imported after the stubs so the service picks up the patched SDK.
const { uploadService } = await import('../src/modules/uploads/upload.service.js')
const { prisma } = await import('../src/config/prisma.js')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

console.log('\n### Upload path (Cloudinary stubbed)\n')

check('service reports configured when creds are present', uploadService.isConfigured)

// --- Single upload ---------------------------------------------------------
const asset = await uploadService.uploadImage(
  { buffer: PNG, originalName: 'pixel.png', mimeType: 'image/png' },
  { alt: 'A single pixel', tags: ['verify', 'stub'] },
)

check('returns a record with an id', typeof asset['id'] === 'string')
check('serializes to snake_case', 'secure_url' in asset && 'public_id' in asset && 'original_filename' in asset)
check('secure_url is the https delivery URL', String(asset['secure_url']).startsWith('https://res.cloudinary.com/'))
check('records the byte length actually streamed', asset['bytes'] === PNG.length, `${String(asset['bytes'])} bytes`)
check('keeps the original filename', asset['original_filename'] === 'pixel.png')
check('stores alt text and tags', asset['alt'] === 'A single pixel' && JSON.stringify(asset['tags']) === '["verify","stub"]')
check('uses the configured default folder', uploadCalls[0]?.['folder'] === 'ghlprime', String(uploadCalls[0]?.['folder']))
check('requests auto format + quality', uploadCalls[0]?.['fetch_format'] === 'auto' && uploadCalls[0]?.['quality'] === 'auto')
check('pins resource_type to image', uploadCalls[0]?.['resource_type'] === 'image')

// --- Persistence -----------------------------------------------------------
const stored = await prisma.mediaAsset.findUnique({ where: { id: String(asset['id']) } })
check('row is persisted in media_assets', stored !== null)
check('public_id is stored for later deletion', stored?.publicId === asset['public_id'])

// --- Folder override -------------------------------------------------------
const custom = await uploadService.uploadImage({ buffer: PNG, originalName: 'c.png' }, { folder: 'ghlprime/case-studies' })
check('honours a per-upload folder override', uploadCalls[1]?.['folder'] === 'ghlprime/case-studies')

// --- Media library listing -------------------------------------------------
const listed = await uploadService.listAssets({ page: 1, limit: 10 })
check('media library lists the uploads', listed.meta.total >= 2, `total=${listed.meta.total}`)
check('listing is newest-first', String(listed.data[0]?.['id']) === String(custom['id']))

// --- Search ----------------------------------------------------------------
const searched = await uploadService.listAssets({ page: 1, limit: 10, search: 'pixel' })
check('search matches the original filename', searched.meta.total === 1, `total=${searched.meta.total}`)

// --- Multi upload ----------------------------------------------------------
const many = await uploadService.uploadImages(
  [
    { buffer: PNG, originalName: 'm1.png' },
    { buffer: PNG, originalName: 'm2.png' },
  ],
  { folder: 'ghlprime/bulk' },
)
check('uploads several files', many.uploaded.length === 2 && many.failed.length === 0)

// --- Overwrite (same public_id returned twice) ------------------------------
const countBeforeOverwrite = await prisma.mediaAsset.count()
assetCounter = 0 // force the stub to reuse the very first public_id
const overwritten = await uploadService.uploadImage({ buffer: PNG, originalName: 'pixel-v2.png' }, {})
const countAfterOverwrite = await prisma.mediaAsset.count()

check('re-uploading an existing public_id does not error', typeof overwritten['id'] === 'string')
check('overwrite updates in place rather than duplicating', countAfterOverwrite === countBeforeOverwrite,
  `${countBeforeOverwrite} -> ${countAfterOverwrite}`)
check('overwrite refreshes the row', overwritten['original_filename'] === 'pixel-v2.png')
check('overwrite keeps the same row id', overwritten['id'] === asset['id'])

// --- Delete ----------------------------------------------------------------
const deleted = await uploadService.destroyById(String(asset['id']))
check('delete reports the public_id', deleted.public_id === asset['public_id'])
check('delete calls Cloudinary destroy', destroyCalls.includes(String(asset['public_id'])))

const afterDelete = await prisma.mediaAsset.findUnique({ where: { id: String(asset['id']) } })
check('local row is removed after delete', afterDelete === null)

// --- Signature -------------------------------------------------------------
const signature = uploadService.createUploadSignature('ghlprime/direct')
check('creates a signature for direct uploads', typeof signature.signature === 'string' && signature.signature.length > 20)
check('signature response never includes the api_secret', !JSON.stringify(signature).includes('test-secret-value'))
check('signature echoes the requested folder', signature.folder === 'ghlprime/direct')

// --- Cleanup ---------------------------------------------------------------
const leftovers = [custom, ...many.uploaded].map((row) => String(row['id']))
await prisma.mediaAsset.deleteMany({ where: { id: { in: leftovers } } })

const remaining = await prisma.mediaAsset.count()
check('test rows cleaned up', remaining === 0, `${remaining} remaining`)

await prisma.$disconnect()

console.log(`\n${'='.repeat(60)}\nPASS: ${passed}   FAIL: ${failed}\n`)
process.exit(failed > 0 ? 1 : 0)
