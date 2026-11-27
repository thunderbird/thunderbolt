/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import type { AdminConnectionDetail, ScimCredential } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createAdminTestHarness, flush, pickDate, type FakeReply, type FakeRequest } from '../../test-utils'
import { RetireScimDialog } from './retire-scim-dialog'
import { ScimSection } from './scim-section'

const credential: ScimCredential = {
  credentialId: 'cred-1234567890',
  status: 'active',
  scopes: ['scim.users.read'],
  expiresAt: '2027-11-17T12:00:00.000Z',
  createdAt: '2026-11-17T12:00:00.000Z',
  createdBy: 'admin-1',
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
}

const ssoOnly: AdminConnectionDetail = {
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
    discoveryEndpoint: null,
  },
  scim: null,
  claimedDomains: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  lockedFields: [],
  scimCredentials: [],
}

const withScim: AdminConnectionDetail = { ...ssoOnly, scim: { scimConnectionId: 's1' }, scimCredentials: [credential] }

const renderSection = (detail: AdminConnectionDetail, respond: (request: FakeRequest) => FakeReply = () => ({})) => {
  const harness = createAdminTestHarness(respond)
  const dirty: (boolean | 'secret')[] = []
  render(<ScimSection detail={detail} onDirty={(value) => dirty.push(value)} />, { wrapper: harness.wrapper })
  return { ...harness, dirty }
}

const holdsToken = (harness: ReturnType<typeof createAdminTestHarness>) =>
  harness.queryClient
    .getMutationCache()
    .getAll()
    .some((mutation) => JSON.stringify(mutation.state.data ?? null).includes('scim-token'))

describe('ScimSection', () => {
  beforeAll(setupTestDatabase)
  // The expiry picker refuses past days, so the date the tests pick has to stay in the future.
  beforeEach(() => {
    getClock().setSystemTime(new Date('2026-11-20T00:00:00'))
  })
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('warns that SCIM makes sign-in SSO-only, then turns it on with the chosen expiry and shows the token once', async () => {
    const harness = renderSection(ssoOnly, ({ path }) =>
      path === 'admin/connections/scim' ? { body: { connection: {}, credential, token: 'scim-token' } } : {},
    )
    expect(screen.getByText('Sign-in becomes SSO-only')).toBeInTheDocument()

    pickDate('Expires on', '2027-03-09')
    fireEvent.click(screen.getByRole('button', { name: 'Turn on SCIM' }))
    await flush()

    const create = harness.requests.find((request) => request.path === 'admin/connections/scim')
    expect(create?.body).toEqual({
      identityConnectionId: 'c1',
      expiresAt: new Date(2027, 2, 9, 23, 59, 59, 999).toISOString(),
    })
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token')
    expect((screen.getByRole('textbox', { name: 'SCIM base URL' }) as HTMLInputElement).value).toMatch(
      /\/v1\/api\/auth\/scim\/v2$/,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await flush()
    expect(screen.queryByRole('textbox', { name: 'SCIM token' })).toBeNull()
    expect(holdsToken(harness)).toBe(false)
  })

  it('lists credentials with their expiry and revokes one after confirming', async () => {
    const harness = renderSection(withScim)
    const row = screen.getByRole('listitem', { name: 'Credential 34567890' })
    expect(within(row).getByText(/expires/)).toBeInTheDocument()
    expect(within(row).getByText('Never used')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke credential 34567890' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke credential' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'POST')).toMatchObject({
      path: 'admin/connections/c1/scim/credentials/cred-1234567890/revoke',
    })
  })

  it('issues a new credential without an expiry, leaving it to the server', async () => {
    const harness = renderSection(withScim, () => ({ body: { credential, token: 'scim-token-2' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue a new credential' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'POST')).toMatchObject({
      path: 'admin/connections/c1/scim/credentials',
      body: {},
    })
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-2')
  })

  it('issues nothing more while a token is shown, and keeps the page dirty until Done', async () => {
    const harness = renderSection(withScim, () => ({ body: { credential, token: 'scim-token-2' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue a new credential' }))
    await flush()

    expect(screen.getByRole('button', { name: 'Issue a new credential' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Issue a new credential' }))
    await flush()
    expect(harness.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(harness.dirty).toEqual(['secret'])

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await flush()
    expect(harness.dirty).toEqual(['secret', false])
    expect(screen.getByRole('button', { name: 'Issue a new credential' })).toBeEnabled()
  })

  it('guards the panel while a credential is being issued, and lets go if issuing fails', async () => {
    const harness = renderSection(withScim, () => ({ status: 500, body: {} }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue a new credential' }))
    expect(harness.dirty).toEqual(['secret'])

    await flush()
    expect(harness.dirty).toEqual(['secret', false])
  })

  it('retires SCIM after confirming, from the dialog the ⋯ menu opens', async () => {
    const harness = createAdminTestHarness(() => ({ status: 202, body: withScim }))
    const onClose = mock()
    render(<RetireScimDialog connection={withScim} onClose={onClose} />, { wrapper: harness.wrapper })
    expect(screen.getByRole('alertdialog')).toHaveTextContent(`Retire SCIM for ${withScim.name}?`)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Retire SCIM' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'POST')?.path).toBe('admin/connections/c1/scim/retire')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Retire SCIM out of the tab body', () => {
    renderSection(withScim)
    expect(screen.queryByRole('button', { name: 'Retire SCIM' })).toBeNull()
  })

  it('shows the retirement in progress, with nothing to issue or revoke', () => {
    renderSection({ ...withScim, status: 'scim_retiring' })
    expect(screen.getByRole('status')).toHaveTextContent('Retiring.')
    expect(screen.queryByRole('button', { name: 'Issue a new credential' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Revoke credential/ })).toBeNull()
  })

  it('lets the env connection take SCIM', () => {
    renderSection({ ...ssoOnly, id: 'sso', sso: { ...ssoOnly.sso!, envOwned: true } })
    expect(screen.getByRole('button', { name: 'Turn on SCIM' })).toBeInTheDocument()
  })
})
