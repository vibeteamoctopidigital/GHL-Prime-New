import type { TeamMember, TeamPageMember } from '@prisma/client'
import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'
import { defaultSerializer } from '../../shared/serializers/caseTransform.js'

/**
 * Leadership profiles — the /team "Leaders" tab and /admin/leaders.
 * `team_members` has no `published` column: every row is public.
 */
export const teamMemberService = new SortableService<TeamMember>({
  model: prisma.teamMember,
  resourceName: 'Team member',
  publishable: false,
  searchableFields: ['name', 'role'],
  serialize: defaultSerializer,
})

/** "Meet The Experts" profiles — /admin/experts, read by the About/Team pages. */
export const teamPageMemberService = new SortableService<TeamPageMember>({
  model: prisma.teamPageMember,
  resourceName: 'Team page expert',
  searchableFields: ['name', 'title'],
  serialize: defaultSerializer,
})
