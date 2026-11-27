/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { presetMatchClaim } from './provider-presets'

describe('presetMatchClaim', () => {
  it('matches Entra on its object id', () => {
    expect(presetMatchClaim('entra', 'oidc')).toBe('oid')
    expect(presetMatchClaim('entra', 'saml')).toBe('http://schemas.microsoft.com/identity/claims/objectidentifier')
  })

  it('matches Okta and Keycloak on sub under OIDC', () => {
    expect(presetMatchClaim('okta', 'oidc')).toBe('sub')
    expect(presetMatchClaim('keycloak', 'oidc')).toBe('sub')
  })

  it('leaves the SAML attribute to the admin where the provider has no fixed one', () => {
    expect(presetMatchClaim('keycloak', 'saml')).toBe('')
    expect(presetMatchClaim('other', 'saml')).toBe('')
  })
})
