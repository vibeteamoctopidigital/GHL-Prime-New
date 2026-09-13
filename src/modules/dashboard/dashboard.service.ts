import prisma from '../../config/prisma.js'
import type { PrismaModelDelegate } from '../../shared/services/BaseService.js'

export interface ContentCounts {
  case_studies: { total: number; published: number; drafts: number }
  blog_posts: { total: number; published: number; drafts: number }
  team_members: number
  team_experts: number
  gallery_categories: number
  gallery_images: number
  meeting_gallery: number
  partner_logos: number
  technology_logos: number
  showcase_items: number
  showcase_stats: number
  contact_leads: { total: number; new: number }
  service_surveys: { total: number; new: number }
}

export interface RecentActivity {
  case_studies: Record<string, unknown>[]
  blog_posts: Record<string, unknown>[]
  contact_leads: Record<string, unknown>[]
  service_surveys: Record<string, unknown>[]
}

/**
 * The same table-name -> Prisma-model-delegate mapping every BaseService
 * subclass sets up individually via its `model:` constructor option — this
 * service works across many tables dynamically instead, so it needs its own
 * copy of that lookup rather than one fixed delegate.
 */
type TableName =
  | 'case_studies'
  | 'blog_posts'
  | 'team_members'
  | 'team_page_members'
  | 'gallery_categories'
  | 'gallery_images'
  | 'meeting_gallery'
  | 'partner_logos'
  | 'technology_logos'
  | 'showcase_items'
  | 'showcase_stats'
  | 'contact_leads'
  | 'service_surveys'

const MODELS: Record<TableName, PrismaModelDelegate> = {
  case_studies: prisma.caseStudy,
  blog_posts: prisma.blogPost,
  team_members: prisma.teamMember,
  team_page_members: prisma.teamPageMember,
  gallery_categories: prisma.galleryCategory,
  gallery_images: prisma.galleryImage,
  meeting_gallery: prisma.meetingGallery,
  partner_logos: prisma.partnerLogo,
  technology_logos: prisma.technologyLogo,
  showcase_items: prisma.showcaseItem,
  showcase_stats: prisma.showcaseStat,
  contact_leads: prisma.contactLead,
  service_surveys: prisma.serviceSurvey,
}

async function countRows(table: TableName, filter?: { column: string; value: unknown }): Promise<number> {
  return MODELS[table].count({ where: filter ? { [filter.column]: filter.value } : {} })
}

/**
 * Read-only aggregates for the admin dashboard landing page, so it can show
 * real numbers instead of fetching every collection just to count it.
 */
class DashboardService {
  async counts(): Promise<ContentCounts> {
    const [
      caseStudiesTotal,
      caseStudiesPublished,
      blogTotal,
      blogPublished,
      teamMembers,
      teamExperts,
      galleryCategories,
      galleryImages,
      meetingGallery,
      partnerLogos,
      technologyLogos,
      showcaseItems,
      showcaseStats,
      contactTotal,
      contactNew,
      surveyTotal,
      surveyNew,
    ] = await Promise.all([
      countRows('case_studies'),
      countRows('case_studies', { column: 'published', value: true }),
      countRows('blog_posts'),
      countRows('blog_posts', { column: 'published', value: true }),
      countRows('team_members'),
      countRows('team_page_members'),
      countRows('gallery_categories'),
      countRows('gallery_images'),
      countRows('meeting_gallery'),
      countRows('partner_logos'),
      countRows('technology_logos'),
      countRows('showcase_items'),
      countRows('showcase_stats'),
      countRows('contact_leads'),
      countRows('contact_leads', { column: 'status', value: 'NEW' }),
      countRows('service_surveys'),
      countRows('service_surveys', { column: 'status', value: 'NEW' }),
    ])

    return {
      case_studies: {
        total: caseStudiesTotal,
        published: caseStudiesPublished,
        drafts: caseStudiesTotal - caseStudiesPublished,
      },
      blog_posts: { total: blogTotal, published: blogPublished, drafts: blogTotal - blogPublished },
      team_members: teamMembers,
      team_experts: teamExperts,
      gallery_categories: galleryCategories,
      gallery_images: galleryImages,
      meeting_gallery: meetingGallery,
      partner_logos: partnerLogos,
      technology_logos: technologyLogos,
      showcase_items: showcaseItems,
      showcase_stats: showcaseStats,
      contact_leads: { total: contactTotal, new: contactNew },
      service_surveys: { total: surveyTotal, new: surveyNew },
    }
  }

  /** The most recently touched records in each collection. */
  async recent(limit = 5): Promise<RecentActivity> {
    const recentRows = async (table: TableName, select: Record<string, boolean>, orderColumn: string) => {
      const rows = await MODELS[table].findMany({
        select,
        orderBy: { [orderColumn]: 'desc' },
        take: limit,
      })

      return rows as Record<string, unknown>[]
    }

    const [caseStudies, blogPosts, contactLeads, serviceSurveys] = await Promise.all([
      recentRows('case_studies', { id: true, title: true, slug: true, published: true, updated_at: true }, 'updated_at'),
      recentRows('blog_posts', { id: true, title: true, slug: true, published: true, updated_at: true }, 'updated_at'),
      recentRows('contact_leads', { id: true, full_name: true, email: true, submitted_at: true }, 'submitted_at'),
      recentRows('service_surveys', { id: true, name: true, service: true, submitted_at: true }, 'submitted_at'),
    ])

    return {
      case_studies: caseStudies,
      blog_posts: blogPosts,
      contact_leads: contactLeads,
      service_surveys: serviceSurveys,
    }
  }
}

export const dashboardService = new DashboardService()
export default dashboardService
