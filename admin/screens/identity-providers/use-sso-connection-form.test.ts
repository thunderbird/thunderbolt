/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import {
  buildCreateSsoBody,
  initialSsoCreateDraft,
  ssoCreateReducer,
  type SsoCreateDraft,
} from './use-sso-connection-form'

const fill = (draft: SsoCreateDraft, values: Partial<Record<keyof SsoCreateDraft, string>>) =>
  Object.entries(values).reduce(
    (current, [field, value]) =>
      ssoCreateReducer(current, { type: 'set', field: field as 'name', value: value as string }),
    draft,
  )

describe('buildCreateSsoBody', () => {
  it('builds an OIDC body, trimmed, leaving a blank discovery URL to the server', () => {
    const draft = fill(initialSsoCreateDraft('oidc'), {
      name: ' Acme ',
      providerId: 'acme',
      issuer: 'https://idp.test',
      clientId: 'client',
      clientSecret: 'secret ',
    })
    expect(buildCreateSsoBody('oidc', draft)).toEqual({
      name: 'Acme',
      providerId: 'acme',
      protocol: { oidc: { issuer: 'https://idp.test', clientId: 'client', clientSecret: 'secret' } },
      matchClaim: 'sub',
    })
  })

  it('sends a discovery URL when one is given', () => {
    const draft = fill(initialSsoCreateDraft('oidc'), { discoveryEndpoint: 'https://idp.test/.well-known/x' })
    const body = buildCreateSsoBody('oidc', draft)
    expect('oidc' in body.protocol && body.protocol.oidc.discoveryEndpoint).toBe('https://idp.test/.well-known/x')
  })

  it('builds a SAML body and omits a blank match claim', () => {
    const draft = fill(initialSsoCreateDraft('saml'), {
      name: 'Acme',
      providerId: 'acme',
      entityId: 'https://sp.test',
      entryPoint: 'https://idp.test/sso',
      cert: 'CERT',
      idpIssuer: 'https://idp.test',
    })
    expect(buildCreateSsoBody('saml', draft)).toEqual({
      name: 'Acme',
      providerId: 'acme',
      protocol: {
        saml: {
          entityId: 'https://sp.test',
          entryPoint: 'https://idp.test/sso',
          cert: 'CERT',
          idpIssuer: 'https://idp.test',
        },
      },
    })
  })

  it('attaches to a connection with its id and current name', () => {
    const draft = fill(initialSsoCreateDraft('oidc'), { name: 'ignored', providerId: 'acme' })
    expect(buildCreateSsoBody('oidc', draft, { id: 'c1', name: 'Acme SCIM' })).toMatchObject({
      name: 'Acme SCIM',
      identityConnectionId: 'c1',
    })
  })
})

describe('ssoCreateReducer', () => {
  it('sets the match claim from the provider until the admin types one', () => {
    const entra = ssoCreateReducer(initialSsoCreateDraft('oidc'), { type: 'preset', preset: 'entra', protocol: 'oidc' })
    expect(entra.matchClaim).toBe('oid')

    const typed = ssoCreateReducer(entra, { type: 'set', field: 'matchClaim', value: 'employee_id' })
    const okta = ssoCreateReducer(typed, { type: 'preset', preset: 'okta', protocol: 'oidc' })
    expect(okta).toMatchObject({ preset: 'okta', matchClaim: 'employee_id' })
  })
})
