import { Router } from 'express'
import createCrudRouter from '../../shared/factories/createCrudRouter.js'
import defineResourceSchema from '../../shared/validators/defineResourceSchema.js'
import { optionalString, optionalUrl, requiredString } from '../../shared/validators/common.validators.js'
import { teamMemberService, teamPageMemberService } from './team.service.js'

// --- Leaders (team_members) -------------------------------------------------
const leaderSchemas = defineResourceSchema({
  fields: {
    name: requiredString('Name'),
    role: requiredString('Role'),
    description: optionalString,
    imageUrl: optionalString,
    linkedinUrl: optionalUrl,
    facebookUrl: optionalUrl,
    instagramUrl: optionalUrl,
    twitterUrl: optionalUrl,
    upworkUrl: optionalUrl,
    websiteUrl: optionalUrl,
  },
  required: ['name', 'role'],
})

// --- Experts (team_page_members) -------------------------------------------
// title and image_url are NOT NULL in the database, so they are required here.
const expertSchemas = defineResourceSchema({
  fields: {
    name: requiredString('Name'),
    title: requiredString('Title'),
    imageUrl: requiredString('Image URL'),
  },
  required: ['name', 'title', 'imageUrl'],
})

const membersRouter = createCrudRouter({
  service: teamMemberService,
  label: 'Team member',
  createSchema: leaderSchemas.createSchema,
  updateSchema: leaderSchemas.updateSchema,
})

const expertsRouter = createCrudRouter({
  service: teamPageMemberService,
  label: 'Team page expert',
  createSchema: expertSchemas.createSchema,
  updateSchema: expertSchemas.updateSchema,
})

const router = Router()

// /team/members -> leaders   |   /team/experts -> "Meet The Experts"
router.use('/members', membersRouter)
router.use('/experts', expertsRouter)
// Bare /team is the leaders list, matching the old fetchTeamMembers() default.
router.use('/', membersRouter)

export default router
