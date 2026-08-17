import type { Prisma } from '@prisma/client'

/**
 * Static seed content, ported from the Supabase sample-data SQL and from the
 * fallback arrays the frontend used when Supabase was unreachable.
 * Kept separate from seed.ts so the seeding logic stays readable.
 */

export const PARTNER_LOGO_SEED: Prisma.PartnerLogoCreateInput[] = [
  {
    companyName: 'GoHighLevel',
    imageUrl: 'https://s3.amazonaws.com/cdn.hotglue.xyz/images/logos/gohighlevel.png',
    websiteUrl: 'https://www.gohighlevel.com',
    sortOrder: 1,
    published: true,
  },
]

export const TECHNOLOGY_LOGO_SEED: Prisma.TechnologyLogoCreateInput[] = [
  { name: 'OpenAI', imageUrl: 'https://cdn.simpleicons.org/openai/412991', sortOrder: 1, published: true },
  { name: 'Make', imageUrl: 'https://cdn.simpleicons.org/make/6D00CC', sortOrder: 2, published: true },
  { name: 'Zapier', imageUrl: 'https://cdn.simpleicons.org/zapier/FF4F00', sortOrder: 3, published: true },
  { name: 'n8n', imageUrl: 'https://cdn.simpleicons.org/n8n/EA4B71', sortOrder: 4, published: true },
  { name: 'Supabase', imageUrl: 'https://cdn.simpleicons.org/supabase/3ECF8E', sortOrder: 5, published: true },
  { name: 'Google Cloud', imageUrl: 'https://cdn.simpleicons.org/googlecloud/4285F4', sortOrder: 6, published: true },
  { name: 'Meta', imageUrl: 'https://cdn.simpleicons.org/meta/0866FF', sortOrder: 7, published: true },
  { name: 'JavaScript', imageUrl: 'https://cdn.simpleicons.org/javascript/F7DF1E', sortOrder: 8, published: true },
  { name: 'Python', imageUrl: 'https://cdn.simpleicons.org/python/3776AB', sortOrder: 9, published: true },
  { name: 'Docker', imageUrl: 'https://cdn.simpleicons.org/docker/2496ED', sortOrder: 10, published: true },
]

export const MEETING_GALLERY_SEED: Prisma.MeetingGalleryItemCreateInput[] = [
  {
    title: 'Client strategy session',
    imageUrl:
      'https://images.leadconnectorhq.com/image/f_webp/q_80/r_1200/u_https://assets.cdn.filesafe.space/j53xn6YJHwIdPImV00rn/media/67c6ef-example-meeting-1.png',
    sortOrder: 1,
    published: true,
  },
  {
    title: 'Growth planning call',
    imageUrl:
      'https://images.leadconnectorhq.com/image/f_webp/q_80/r_1200/u_https://assets.cdn.filesafe.space/j53xn6YJHwIdPImV00rn/media/67c6ef-example-meeting-2.png',
    sortOrder: 2,
    published: true,
  },
  {
    title: 'Workflow review meeting',
    imageUrl:
      'https://images.leadconnectorhq.com/image/f_webp/q_80/r_1200/u_https://assets.cdn.filesafe.space/j53xn6YJHwIdPImV00rn/media/67c6ef-example-meeting-3.png',
    sortOrder: 3,
    published: true,
  },
]

export const GALLERY_CATEGORY_SEED: Prisma.GalleryCategoryCreateInput[] = [
  { name: 'Events', slug: 'events', sortOrder: 1, published: true },
  { name: 'Office', slug: 'office', sortOrder: 2, published: true },
  { name: 'Team Activities', slug: 'team', sortOrder: 3, published: true },
]

export interface GalleryImageSeed {
  title: string
  imageUrl: string
  categorySlug: string
  sortOrder: number
  published: boolean
}

export const GALLERY_IMAGE_SEED: GalleryImageSeed[] = [
  {
    title: 'Team workshop',
    imageUrl: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=60',
    categorySlug: 'events',
    sortOrder: 1,
    published: true,
  },
  {
    title: 'At the office',
    imageUrl: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1200&q=60',
    categorySlug: 'office',
    sortOrder: 2,
    published: true,
  },
  {
    title: 'Team lunch',
    imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1200&q=60',
    categorySlug: 'team',
    sortOrder: 3,
    published: true,
  },
]

export const SHOWCASE_STAT_SEED: Prisma.ShowcaseStatCreateInput[] = [
  { value: '10+', label: 'LIVE PRODUCTS', sortOrder: 1, published: true },
  { value: '100K+', label: 'USERS SERVED', sortOrder: 2, published: true },
  { value: '6', label: 'ENTERPRISE SYSTEMS', sortOrder: 3, published: true },
  { value: '5+', label: 'YEARS IN PRODUCTION', sortOrder: 4, published: true },
]

export interface ShowcaseItemSeed {
  originName: string
  originUrl: string
  originIcon: string
  originDescription: string
  originTagline: string
  adaptationBadge: string
  adaptationName: string
  adaptationDescription: string
  adaptationTags: string[]
  sortOrder: number
  published: boolean
  placements: { pageKey: string; sortOrder: number }[]
}

export const SHOWCASE_ITEM_SEED: ShowcaseItemSeed[] = [
  {
    originName: 'PhotoFox AI',
    originUrl: 'photofoxai.com',
    originIcon: '',
    originDescription:
      'Lets anyone turn a photo into a branded campaign visual in seconds. Used by 50K+ creators, marketers, and small teams.',
    originTagline: 'Photo -> branded campaign visual',
    adaptationBadge: 'Enterprise Adaptation',
    adaptationName: 'Chitron AI',
    adaptationDescription:
      'AI Creative Infrastructure for retail and D2C teams. Batch visual generation with brand consistency enforced at scale, connected via API to your existing commerce stack.',
    adaptationTags: ['RETAIL', 'D2C', 'BRAND'],
    sortOrder: 1,
    published: true,
    placements: [{ pageKey: 'home', sortOrder: 1 }],
  },
  {
    originName: 'Vocalo AI',
    originUrl: 'vocalo.ai',
    originIcon: '',
    originDescription:
      'Real-time AI voice coaching and speech analysis for individuals. 100K+ voice interactions processed, with live feedback on tone, clarity, and pacing.',
    originTagline: 'Real-time AI voice + speech analysis',
    adaptationBadge: 'Enterprise Adaptation',
    adaptationName: 'Dhoni AI',
    adaptationDescription:
      'AI Communication Intelligence for call centers and sales teams. Live agent assist, post-call analytics, compliance flagging, and CRM integration on enterprise telephony.',
    adaptationTags: ['BPO', 'CALL CENTERS', 'HR', 'SALES'],
    sortOrder: 2,
    published: true,
    placements: [{ pageKey: 'home', sortOrder: 2 }],
  },
  {
    originName: 'SketchToImage',
    originUrl: 'sketchtoimage.com',
    originIcon: '',
    originDescription:
      'Transforms hand-drawn sketches into polished visuals in one click. Built for designers, architects, and product teams who think in rough drafts.',
    originTagline: 'Sketch -> polished visual',
    adaptationBadge: 'Enterprise Adaptation',
    adaptationName: 'Rupon AI',
    adaptationDescription:
      'AI Design Visualization for architecture, real estate, and product studios. From concept sketch to client-ready rendering with brand templates and revision history.',
    adaptationTags: ['ARCHITECTURE', 'REAL ESTATE', 'PRODUCT DESIGN'],
    sortOrder: 3,
    published: true,
    placements: [{ pageKey: 'home', sortOrder: 3 }],
  },
]
