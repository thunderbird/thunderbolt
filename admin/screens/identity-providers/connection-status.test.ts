/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { AdminConnection } from '@shared/admin-api'
import { describe, expect, it } from 'bun:test'
import { describeConnection } from './connection-status'

const sso = { providerId: 'acme', protocol: 'oidc', issuer: 'https://idp.test', envOwned: false } as const
const scim = { scimConnectionId: 'scim-1' }

const connection = (overrides: Partial<AdminConnection>) => ({
  sso: null,
  scim: null,
  status: 'active' as const,
  ...overrides,
})

describe('describeConnection', () => {
  it('lets an SSO-only connection be edited, retired and given SCIM', () => {
    expect(describeConnection(connection({ sso }))).toMatchObject({
      scim: null,
      retired: false,
      canEditSso: true,
      canRetireSso: true,
      canAddSso: false,
      canAddScim: true,
    })
  })

  it('refuses to retire the SSO side while SCIM is active or retiring', () => {
    expect(describeConnection(connection({ sso, scim })).canRetireSso).toBe(false)
    expect(describeConnection(connection({ sso, scim, status: 'scim_retiring' }))).toMatchObject({
      scim: 'retiring',
      canRetireSso: false,
      canAddScim: false,
    })
    expect(describeConnection(connection({ sso, scim, status: 'scim_retired' }))).toMatchObject({
      scim: 'retired',
      retired: false,
      canRetireSso: true,
    })
  })

  it('offers SSO but never a rename on a SCIM-only connection', () => {
    expect(describeConnection(connection({ scim }))).toMatchObject({
      scim: 'active',
      canEditSso: false,
      canRetireSso: false,
      canAddSso: true,
      canAddScim: false,
    })
  })

  it('treats a SCIM-only connection with its SCIM retired as retired', () => {
    expect(describeConnection(connection({ scim, status: 'scim_retired' }))).toMatchObject({
      retired: true,
      canAddSso: false,
    })
  })

  it('keeps the env connection read-only but lets it take SCIM', () => {
    expect(describeConnection(connection({ sso: { ...sso, envOwned: true } }))).toMatchObject({
      canEditSso: false,
      canRetireSso: false,
      canAddScim: true,
    })
  })

  it('offers nothing on a retired connection', () => {
    expect(describeConnection(connection({ sso, scim, status: 'retired' }))).toEqual({
      sso,
      scim: 'retired',
      retired: true,
      canEditSso: false,
      canRetireSso: false,
      canAddSso: false,
      canAddScim: false,
    })
  })
})
