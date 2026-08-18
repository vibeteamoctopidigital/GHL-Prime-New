import supabase from '../../config/supabase.js'

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

/** `head: true` returns only the count — no rows cross the wire. */
async function countRows(table: string, filter?: { column: string; value: unknown }): Promise<number> {
  let query = supabase.from(table).select('id', { count: 'exact', head: true })
  if (filter) query = query.eq(filter.column, filter.value as never)

  const { count } = await query
  return count ?? 0
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
    const recentRows = async (table: string, columns: string, orderColumn: string) => {
      const { data } = await supabase
        .from(table)
        .select(columns)
        .order(orderColumn, { ascending: false })
        .limit(limit)

      return (data ?? []) as unknown as Record<string, unknown>[]
    }

    const [caseStudies, blogPosts, contactLeads, serviceSurveys] = await Promise.all([
      recentRows('case_studies', 'id, title, slug, published, updated_at', 'updated_at'),
      recentRows('blog_posts', 'id, title, slug, published, updated_at', 'updated_at'),
      recentRows('contact_leads', 'id, full_name, email, submitted_at', 'submitted_at'),
      recentRows('service_surveys', 'id, name, service, submitted_at', 'submitted_at'),
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
