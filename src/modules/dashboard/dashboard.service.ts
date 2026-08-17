import prisma from '../../config/prisma.js'

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
  case_studies: { id: string; title: string; slug: string; published: boolean | null; updated_at: Date }[]
  blog_posts: { id: string; title: string; slug: string; published: boolean | null; updated_at: Date }[]
  contact_leads: { id: string; full_name: string | null; email: string | null; submitted_at: Date }[]
  service_surveys: { id: string; name: string | null; service: string | null; submitted_at: Date }[]
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
      prisma.caseStudy.count(),
      prisma.caseStudy.count({ where: { published: true } }),
      prisma.blogPost.count(),
      prisma.blogPost.count({ where: { published: true } }),
      prisma.teamMember.count(),
      prisma.teamPageMember.count(),
      prisma.galleryCategory.count(),
      prisma.galleryImage.count(),
      prisma.meetingGalleryItem.count(),
      prisma.partnerLogo.count(),
      prisma.technologyLogo.count(),
      prisma.showcaseItem.count(),
      prisma.showcaseStat.count(),
      prisma.contactLead.count(),
      prisma.contactLead.count({ where: { status: 'NEW' } }),
      prisma.serviceSurvey.count(),
      prisma.serviceSurvey.count({ where: { status: 'NEW' } }),
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

  /** The five most recently touched records in each collection. */
  async recent(limit = 5): Promise<RecentActivity> {
    const [caseStudies, blogPosts, contactLeads, serviceSurveys] = await Promise.all([
      prisma.caseStudy.findMany({
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, slug: true, published: true, updatedAt: true },
      }),
      prisma.blogPost.findMany({
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, slug: true, published: true, updatedAt: true },
      }),
      prisma.contactLead.findMany({
        take: limit,
        orderBy: { submittedAt: 'desc' },
        select: { id: true, fullName: true, email: true, submittedAt: true },
      }),
      prisma.serviceSurvey.findMany({
        take: limit,
        orderBy: { submittedAt: 'desc' },
        select: { id: true, name: true, service: true, submittedAt: true },
      }),
    ])

    return {
      case_studies: caseStudies.map((row) => ({ ...row, updated_at: row.updatedAt })),
      blog_posts: blogPosts.map((row) => ({ ...row, updated_at: row.updatedAt })),
      contact_leads: contactLeads.map((row) => ({
        id: row.id,
        full_name: row.fullName,
        email: row.email,
        submitted_at: row.submittedAt,
      })),
      service_surveys: serviceSurveys.map((row) => ({
        id: row.id,
        name: row.name,
        service: row.service,
        submitted_at: row.submittedAt,
      })),
    }
  }
}

export const dashboardService = new DashboardService()
export default dashboardService
