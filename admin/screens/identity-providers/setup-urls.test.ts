/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { oidcRedirectUri, samlAcsUrl, samlMetadataUrl, scimBaseUrl } from './setup-urls'

const cloudUrl = 'https://thunderbolt.example.com/v1/'

describe('setup URLs', () => {
  it('builds the OIDC redirect URI under the auth base', () => {
    expect(oidcRedirectUri(cloudUrl, 'acme')).toBe('https://thunderbolt.example.com/v1/api/auth/sso/callback/acme')
  })

  it('builds the SAML ACS and metadata URLs', () => {
    expect(samlAcsUrl(cloudUrl, 'acme')).toBe('https://thunderbolt.example.com/v1/api/auth/sso/saml2/sp/acs/acme')
    expect(samlMetadataUrl(cloudUrl, 'acme')).toBe(
      'https://thunderbolt.example.com/v1/api/auth/sso/saml2/sp/metadata?providerId=acme',
    )
  })

  it('builds the SCIM base URL', () => {
    expect(scimBaseUrl(cloudUrl)).toBe('https://thunderbolt.example.com/v1/api/auth/scim/v2')
  })

  it('makes a relative cloud URL absolute on the page origin', () => {
    const origin = 'https://app.example.com'
    expect(oidcRedirectUri('/v1', 'acme', origin)).toBe(`${origin}/v1/api/auth/sso/callback/acme`)
    expect(samlAcsUrl('/v1', 'acme', origin)).toBe(`${origin}/v1/api/auth/sso/saml2/sp/acs/acme`)
    expect(samlMetadataUrl('/v1', 'acme', origin)).toBe(`${origin}/v1/api/auth/sso/saml2/sp/metadata?providerId=acme`)
    expect(scimBaseUrl('/v1', origin)).toBe(`${origin}/v1/api/auth/scim/v2`)
  })
})
