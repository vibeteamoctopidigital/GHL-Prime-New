import type { RequestHandler } from 'express'
import { API_PREFIX } from '../../config/constants.js'
import { sendOk } from '../utils/ApiResponse.js'

export interface ModuleEndpoint {
  method: string
  path: string
  description: string
}

/**
 * A browsable index for a module's base path.
 *
 * Several modules have no `GET /` of their own — `/api/auth` exists only as a
 * prefix for `/login`, `/me` and so on. Hitting the base in a browser therefore
 * returned "Route not found", which reads like the deployment is broken rather
 * than like the URL is a prefix. This lists what actually lives underneath.
 */
export function createModuleIndex(base: string, endpoints: ModuleEndpoint[]): RequestHandler {
  return (_req, res) => {
    sendOk(
      res,
      {
        base: `${API_PREFIX}${base}`,
        endpoints: endpoints.map((endpoint) => ({
          ...endpoint,
          path: `${API_PREFIX}${base}${endpoint.path === '/' ? '' : endpoint.path}`,
        })),
      },
      'Available endpoints',
    )
  }
}

export default createModuleIndex
