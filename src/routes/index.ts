import { Router } from 'express'
import env from '../config/env.js'
import { API_PREFIX } from '../config/constants.js'

import healthRoutes from '../modules/health/health.routes.js'
import authRoutes from '../modules/auth/auth.routes.js'
import dashboardRoutes from '../modules/dashboard/dashboard.routes.js'
import caseStudyRoutes from '../modules/case-studies/caseStudy.routes.js'
import blogRoutes from '../modules/blog/blog.routes.js'
import blogWriterRoutes from '../modules/blog-writer/blogWriter.routes.js'
import claudeAuthRoutes from '../modules/claude-auth/claudeAuth.routes.js'
import teamRoutes from '../modules/team/team.routes.js'
import galleryRoutes from '../modules/gallery/gallery.routes.js'
import meetingGalleryRoutes from '../modules/meeting-gallery/meetingGallery.routes.js'
import partnerLogoRoutes from '../modules/partner-logos/partnerLogo.routes.js'
import technologyLogoRoutes from '../modules/technology-logos/technologyLogo.routes.js'
import showcaseRoutes from '../modules/showcase/showcase.routes.js'
import contactRoutes from '../modules/contact/contact.routes.js'
import serviceSurveyRoutes from '../modules/service-surveys/serviceSurvey.routes.js'
import uploadRoutes from '../modules/uploads/upload.routes.js'
import sitemapRoutes from '../modules/sitemap/sitemap.routes.js'

interface RouteDefinition {
  path: string
  router: Router
  description: string
}

/**
 * Single place where every module is mounted. Adding a feature means adding one
 * entry here — nothing else in the app wiring changes.
 */
const routes: RouteDefinition[] = [
  { path: '/health', router: healthRoutes, description: 'Liveness and database readiness' },
  { path: '/auth', router: authRoutes, description: 'JWT authentication and user management' },
  { path: '/dashboard', router: dashboardRoutes, description: 'Admin dashboard counts and recent activity' },
  { path: '/case-studies', router: caseStudyRoutes, description: 'Case studies and team credits' },
  { path: '/blog', router: blogRoutes, description: 'Blog posts, categories and related posts' },
  { path: '/blog-writer', router: blogWriterRoutes, description: 'AI Blog Writer: topic queue, batches, schedules and run history for the Claude-Code-subscription writer' },
  { path: '/claude-auth', router: claudeAuthRoutes, description: 'Claude account manager: status, dashboard-driven login (setup-token), logout for the Blog Writer CLI' },
  { path: '/team', router: teamRoutes, description: 'Leadership profiles and "Meet The Experts"' },
  { path: '/gallery', router: galleryRoutes, description: 'Gallery categories and images' },
  { path: '/meeting-gallery', router: meetingGalleryRoutes, description: 'Homepage meeting image strip' },
  { path: '/partner-logos', router: partnerLogoRoutes, description: 'Trusted-by partner logos' },
  { path: '/technology-logos', router: technologyLogoRoutes, description: 'Technology stack logos' },
  { path: '/showcase', router: showcaseRoutes, description: 'Shipped Evidence items, stats and placements' },
  { path: '/contact', router: contactRoutes, description: 'Contact form submissions and lead inbox' },
  { path: '/service-surveys', router: serviceSurveyRoutes, description: 'Service-page survey submissions' },
  { path: '/uploads', router: uploadRoutes, description: 'Cloudinary image uploads and media library' },
  { path: '/sitemap', router: sitemapRoutes, description: 'Sitemap generation' },
]

const router = Router()

for (const route of routes) {
  router.use(route.path, route.router)
}

/** GET /api — a self-describing index of the mounted modules. */
router.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'GHL Prime API',
    data: {
      name: 'GHL Prime API',
      version: '1.0.0',
      environment: env.NODE_ENV,
      endpoints: routes.map((route) => ({
        path: `${API_PREFIX}${route.path}`,
        description: route.description,
      })),
    },
  })
})

export default router
