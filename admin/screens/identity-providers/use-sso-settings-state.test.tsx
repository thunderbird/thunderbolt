/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { FormEvent } from 'react'
import { createAdminTestHarness, flush } from '../../test-utils'
import {
  buildSsoUpdateBody,
  initialSsoSettingsDraft,
  useSsoSettingsState,
  type SsoConnectionDetail,
} from './use-sso-settings-state'
import { useConnection } from './use-connection-queries'

const oidcDetail: SsoConnectionDetail = {
  id: 'c1',
  name: 'Acme',
  status: 'active',
  matchClaim: 'sub',
  sso: {
    providerId: 'acme',
    protocol: 'oidc',
    issuer: 'https://idp.test',
    envOwned: false,
    clientId: 'client',
    discoveryEndpoint: 'https://idp.test/.well-known/openid-configuration',
  },
  scim: null,
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  lockedFields: [],
  scimCredentials: [],
}

const samlDetail: SsoConnectionDetail = {
  ...oidcDetail,
  sso: {
    providerId: 'acme',
    protocol: 'saml',
    issuer: 'https://sp.test',
    envOwned: false,
    entityId: 'https://sp.test',
    entryPoint: 'https://idp.test/sso',
    idpIssuer: 'https://idp.test',
  },
}

const event = { preventDefault: () => {} } as FormEvent

describe('buildSsoUpdateBody', () => {
  it('prefills the stored settings and leaves the secret blank', () => {
    expect(initialSsoSettingsDraft(oidcDetail)).toEqual({
      name: 'Acme',
      matchClaim: 'sub',
      clientId: 'client',
      discoveryEndpoint: 'https://idp.test/.well-known/openid-configuration',
      entryPoint: '',
      clientSecret: '',
      cert: '',
    })
  })

  it('sends nothing for an unchanged form', () => {
    expect(
      buildSsoUpdateBody(oidcDetail, initialSsoSettingsDraft(oidcDetail), initialSsoSettingsDraft(oidcDetail)),
    ).toEqual({})
  })

  it('sends only the changed fields', () => {
    const draft = { ...initialSsoSettingsDraft(oidcDetail), name: 'Acme Okta', clientSecret: 'new-secret' }
    expect(buildSsoUpdateBody(oidcDetail, initialSsoSettingsDraft(oidcDetail), draft)).toEqual({
      name: 'Acme Okta',
      oidc: { clientSecret: 'new-secret' },
    })
  })

  it('treats an emptied discovery URL as unchanged, never sending an empty string', () => {
    const draft = { ...initialSsoSettingsDraft(oidcDetail), discoveryEndpoint: '  ' }
    expect(buildSsoUpdateBody(oidcDetail, initialSsoSettingsDraft(oidcDetail), draft)).toEqual({})
  })

  it('never sends a locked field', () => {
    const locked = { ...oidcDetail, lockedFields: ['clientId' as const, 'matchClaim' as const] }
    const draft = { ...initialSsoSettingsDraft(locked), clientId: 'other', matchClaim: 'oid', clientSecret: 's' }
    expect(buildSsoUpdateBody(locked, initialSsoSettingsDraft(locked), draft)).toEqual({ oidc: { clientSecret: 's' } })
  })

  it("leaves a field the admin didn't touch out, even after another admin changed it", () => {
    const opened = initialSsoSettingsDraft(oidcDetail)
    const refetched = { ...oidcDetail, name: 'Renamed elsewhere', sso: { ...oidcDetail.sso, clientId: 'new-client' } }
    const draft = { ...opened, clientSecret: 'new-secret' }
    expect(buildSsoUpdateBody(refetched, opened, draft)).toEqual({ oidc: { clientSecret: 'new-secret' } })
  })

  it('replaces a SAML certificate and entry point', () => {
    const draft = { ...initialSsoSettingsDraft(samlDetail), entryPoint: 'https://idp.test/v2', cert: 'CERT' }
    expect(buildSsoUpdateBody(samlDetail, initialSsoSettingsDraft(samlDetail), draft)).toEqual({
      saml: { entryPoint: 'https://idp.test/v2', cert: 'CERT' },
    })
  })
})

describe('useSsoSettingsState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('takes its locks from lockedFields', () => {
    const harness = createAdminTestHarness()
    const detail = { ...oidcDetail, lockedFields: ['clientId' as const] }
    const { result } = renderHook(() => useSsoSettingsState({ detail, onDirty: () => {} }), {
      wrapper: harness.wrapper,
    })
    expect(result.current.isLocked('clientId')).toBe(true)
    expect(result.current.isLocked('discoveryEndpoint')).toBe(false)
    expect(result.current.isLocked('clientSecret')).toBe(false)
  })

  it('shows a lock that landed after the read under its field and reads the connection again', async () => {
    const harness = createAdminTestHarness(({ method }) =>
      method === 'PATCH'
        ? { status: 409, body: { code: 'SSO_IDENTITY_FIELD_LOCKED', field: 'clientId' } }
        : { body: oidcDetail },
    )
    const { result } = renderHook(
      () => ({ detail: useConnection('c1'), form: useSsoSettingsState({ detail: oidcDetail, onDirty: () => {} }) }),
      { wrapper: harness.wrapper },
    )
    await flush()
    const detailReads = () =>
      harness.requests.filter((request) => request.method === 'GET' && request.path === 'admin/connections/c1').length
    expect(detailReads()).toBe(1)

    act(() => result.current.form.setField('clientId', 'other'))
    act(() => result.current.form.submit(event))
    await flush()

    expect(harness.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      oidc: { clientId: 'other' },
    })
    expect(result.current.form.fieldError).toMatchObject({ field: 'clientId', isLock: true })
    expect(result.current.form.formError).toBeNull()
    expect(detailReads()).toBe(2)
  })

  it("saves only the admin's own edit when the connection is read again with another admin's change", async () => {
    const harness = createAdminTestHarness(() => ({ body: oidcDetail }))
    const { result, rerender } = renderHook(({ detail }) => useSsoSettingsState({ detail, onDirty: () => {} }), {
      wrapper: harness.wrapper,
      initialProps: { detail: oidcDetail },
    })

    rerender({ detail: { ...oidcDetail, name: 'Renamed elsewhere' } })
    expect(result.current.hasChanges).toBe(false)
    act(() => result.current.setField('clientSecret', 'new-secret'))
    act(() => result.current.submit(event))
    await flush()

    expect(harness.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      oidc: { clientSecret: 'new-secret' },
    })
  })

  it('resets the replace-only fields after a save', async () => {
    const harness = createAdminTestHarness(() => ({ body: oidcDetail }))
    const dirty: boolean[] = []
    const { result } = renderHook(
      () => useSsoSettingsState({ detail: oidcDetail, onDirty: (value) => dirty.push(value) }),
      { wrapper: harness.wrapper },
    )

    act(() => result.current.setField('clientSecret', 'new-secret'))
    expect(result.current.hasChanges).toBe(true)
    act(() => result.current.submit(event))
    await flush()

    expect(result.current.draft.clientSecret).toBe('')
    expect(result.current.hasChanges).toBe(false)
    expect(dirty).toEqual([true, false])
  })
})
