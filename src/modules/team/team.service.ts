import prisma from '../../config/prisma.js'
import SortableService from '../../shared/services/SortableService.js'

/**
 * Leadership profiles — the /team "Leaders" tab and /admin/leaders.
 * The team_members table has no "published" column: every row is public.
 */
export const teamMemberService = new SortableService({
  model: prisma.teamMember,
  resourceName: 'Team member',
  publishable: false,
  searchableFields: ['name', 'role'],
})

/** "Meet The Experts" profiles — /admin/experts, read by the About/Team pages. */
export const teamPageMemberService = new SortableService({
  model: prisma.teamPageMember,
  resourceName: 'Team page expert',
  searchableFields: ['name', 'title'],
})
