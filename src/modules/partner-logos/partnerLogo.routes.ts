import { z } from 'zod'
import createCrudRouter from '../../shared/factories/createCrudRouter.js'
import { booleanish, optionalUrl, sortOrderSchema } from '../../shared/validators/common.validators.js'
import partnerLogoService from './partnerLogo.service.js'

/**
 * Accepts `name`, `company_name` or `companyName` from the client and always
 * stores `companyName` — the three spellings the admin panel and the public
 * site each use.
 */
const shape = {
  name: z.string().trim().min(1).optional(),
  company_name: z.string().trim().min(1).optional(),
  companyName: z.string().trim().min(1).optional(),
  image_url: optionalUrl,
  imageUrl: optionalUrl,
  website_url: optionalUrl,
  websiteUrl: optionalUrl,
  sort_order: sortOrderSchema,
  sortOrder: sortOrderSchema,
  published: booleanish.optional(),
}

type LogoInput = z.infer<z.ZodObject<typeof shape>>

/** Collapses the accepted aliases into the Prisma field names. */
const normalize = (input: LogoInput): Record<string, unknown> => {
  const companyName = input.companyName ?? input.company_name ?? input.name
  const imageUrl = input.imageUrl ?? input.image_url
  const websiteUrl = input.websiteUrl ?? input.website_url
  const sortOrder = input.sortOrder ?? input.sort_order

  return {
    ...(companyName !== undefined ? { companyName } : {}),
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(websiteUrl !== undefined ? { websiteUrl } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
    ...(input.published !== undefined ? { published: input.published } : {}),
  }
}

const base = z.object(shape)

export const createPartnerLogoSchema = base
  .refine((data) => Boolean(data.name ?? data.company_name ?? data.companyName), {
    message: 'Company name is required',
    path: ['name'],
  })
  .transform(normalize)

export const updatePartnerLogoSchema = base.transform(normalize)

export default createCrudRouter({
  service: partnerLogoService,
  label: 'Partner logo',
  createSchema: createPartnerLogoSchema,
  updateSchema: updatePartnerLogoSchema,
})
