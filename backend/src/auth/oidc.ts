import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'

/** OIDC configuration route — exposes the expected issuer origin for redirect validation. */
export const createOidcConfigRoutes = () => {
  const settings = getSettings()

  if (settings.authMode !== 'oidc' || !settings.oidcIssuer) {
    return new Elysia({ prefix: '/auth/oidc' })
  }

  const issuerOrigin = new URL(settings.oidcIssuer).origin

  return new Elysia({ prefix: '/auth/oidc' })
    .onError(safeErrorHandler)
    .get('/config', () => ({ issuerOrigin }))
}
