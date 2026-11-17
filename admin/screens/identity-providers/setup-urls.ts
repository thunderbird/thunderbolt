/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { resolveAbsoluteBackendUrl } from '@/lib/url-utils'
import { scimBasePath } from '@shared/admin-api'

/*
 * What an admin pastes into their identity provider. Each sits under the cloud URL (`…/v1`), where
 * Better Auth serves `/api/auth`, made absolute: same-origin deployments configure a relative `/v1`,
 * which no provider can call.
 */

/** `origin` defaults to the page's. */
const authUrl = (cloudUrl: string, path: string, origin?: string) =>
  `${resolveAbsoluteBackendUrl(cloudUrl, origin)}/api/auth${path}`

/** The OIDC redirect URI the provider must allow for this connection. */
export const oidcRedirectUri = (cloudUrl: string, providerId: string, origin?: string) =>
  authUrl(cloudUrl, `/sso/callback/${encodeURIComponent(providerId)}`, origin)

/** The SAML assertion consumer service URL. */
export const samlAcsUrl = (cloudUrl: string, providerId: string, origin?: string) =>
  authUrl(cloudUrl, `/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`, origin)

/** Our service provider's SAML metadata, which most providers can import. */
export const samlMetadataUrl = (cloudUrl: string, providerId: string, origin?: string) =>
  authUrl(cloudUrl, `/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`, origin)

/** The SCIM base URL every connection's provider calls. */
export const scimBaseUrl = (cloudUrl: string, origin?: string) =>
  `${resolveAbsoluteBackendUrl(cloudUrl, origin)}${scimBasePath}`
