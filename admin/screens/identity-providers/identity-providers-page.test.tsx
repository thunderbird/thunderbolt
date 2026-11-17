/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnection, AdminConnectionDetail } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { IdentityProvidersPage } from './identity-providers-page'

const base = { matchClaim: 'sub', claimedDomains: [], createdAt: '2026-11-17T00:00:00.000Z' }

const connections: AdminConnection[] = [
  {
    ...base,
    id: 'sso',
    name: 'SSO',
    status: 'active',
    sso: { providerId: 'sso', protocol: 'oidc', issuer: 'https://env.test', envOwned: true },
    scim: null,
  },
  {
    ...base,
    id: 'c1',
    name: 'Acme Entra',
    status: 'scim_retiring',
    sso: { providerId: 'acme', protocol: 'saml', issuer: 'https://sp.test', envOwned: false },
    scim: { scimConnectionId: 's1' },
  },
  { ...base, id: 'c2', name: 'Old', status: 'retired', sso: null, scim: { scimConnectionId: 's2' } },
]

const created: AdminConnectionDetail = {
  ...base,
  id: 'c3',
  name: 'Okta',
  status: 'active',
  sso: {
    providerId: 'okta',
    protocol: 'oidc',
    issuer: 'https://okta.test',
    envOwned: false,
    clientId: 'client',
    discoveryEndpoint: null,
  },
  scim: null,
  lockedFields: [],
  scimCredentials: [],
}

const backend =
  (list: AdminConnection[], createReply: FakeReply = { body: created }) =>
  ({ method, path }: FakeRequest): FakeReply => {
    if (method === 'GET' && path === 'admin/connections') {
      return { body: { items: list } }
    }
    if (method === 'POST' && path === 'admin/connections/sso') {
      return createReply
    }
    return { body: created }
  }

const renderPage = (respond: (request: FakeRequest) => FakeReply) => {
  const harness = createAdminTestHarness(respond)
  render(<IdentityProvidersPage />, { wrapper: harness.wrapper })
  return harness
}

const fillOidcForm = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
  fireEvent.click(screen.getByRole('button', { name: 'Single sign-on with OIDC' }))
  for (const [label, value] of [
    ['Name', 'Okta'],
    ['Provider ID', 'okta'],
    ['Issuer', 'https://okta.test'],
    ['Client ID', 'client'],
    ['Client secret', 'secret'],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }
}

describe('IdentityProvidersPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists each connection with its sign-in, provisioning and status', async () => {
    renderPage(backend(connections))
    await flush()

    const env = screen.getByRole('button', { name: 'SSO' })
    expect(env).toHaveTextContent('OIDC sign-in · Set by server settings')
    expect(env).toHaveTextContent('Active')
    const acme = screen.getByRole('button', { name: 'Acme Entra' })
    expect(acme).toHaveTextContent('SAML sign-in · SCIM retiring')
    expect(acme).toHaveTextContent('Retiring')
    expect(screen.getByRole('button', { name: 'Old' })).toHaveTextContent('Retired')
  })

  it('shows the empty state', async () => {
    renderPage(backend([]))
    await flush()
    expect(screen.getByText(/No identity providers yet/)).toBeInTheDocument()
  })

  it('adds an OIDC connection and shows its redirect URI before saving', async () => {
    const harness = renderPage(backend([]))
    await flush()
    fillOidcForm()
    expect(screen.getByText(/\/api\/auth\/sso\/callback\/okta$/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'POST')).toMatchObject({
      path: 'admin/connections/sso',
      body: {
        name: 'Okta',
        providerId: 'okta',
        protocol: { oidc: { issuer: 'https://okta.test', clientId: 'client', clientSecret: 'secret' } },
        matchClaim: 'sub',
      },
    })
  })

  it('shows a taken provider ID under its field', async () => {
    renderPage(backend([], { status: 409, body: { code: 'SSO_PROVIDER_ID_TAKEN', message: 'taken' } }))
    await flush()
    fillOidcForm()
    fireEvent.submit(screen.getByLabelText('Provider ID').closest('form')!)
    await flush()

    expect(screen.getByLabelText('Provider ID')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('A connection with this provider ID already exists.')
  })
  it('retires a connection after confirming, and offers no retire while SCIM is active', async () => {
    const own: AdminConnection = { ...created, id: 'c3' }
    const withScim: AdminConnectionDetail = { ...created, id: 'c4', name: 'Both', scim: { scimConnectionId: 's4' } }
    const harness = renderPage(({ method, path }) => {
      if (method === 'GET' && path === 'admin/connections') {
        return { body: { items: [own, withScim] } }
      }
      if (path === 'admin/connections/c4') {
        return { body: withScim }
      }
      return { body: created }
    })
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Both' }))
    await flush()
    expect(screen.getByText('To retire this connection, retire its SCIM provisioning first.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Okta' }))
    await flush()
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retire connection' }))
    await flush()
    expect(screen.getByText(/Nobody can sign in through it any more/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retire connection' }))
    await flush()
    expect(
      harness.requests.some((request) => request.method === 'POST' && request.path === 'admin/connections/c3/retire'),
    ).toBe(true)
  })
  it('creates a SCIM-only connection and shows its token once', async () => {
    const credential = {
      credentialId: 'cred-1',
      status: 'active',
      scopes: [],
      expiresAt: '2027-11-17T00:00:00.000Z',
      createdAt: '2026-11-17T00:00:00.000Z',
      createdBy: 'admin-1',
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    }
    const harness = renderPage(({ method, path }) =>
      method === 'POST' && path === 'admin/connections/scim'
        ? { body: { connection: { id: 'c9' }, credential, token: 'scim-token-9' } }
        : backend([])({ method, path } as FakeRequest),
    )
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.click(screen.getByRole('button', { name: 'SCIM provisioning only' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Okta SCIM' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create connection' }))
    await flush()

    expect(harness.requests.find((request) => request.path === 'admin/connections/scim')?.body).toEqual({
      name: 'Okta SCIM',
    })
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-9')

    // Closing before Done asks first, so the token isn't dropped unseen.
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    await flush()
    expect(screen.getByText('Discard unsaved changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await flush()
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-9')

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await flush()
    expect(screen.queryByRole('textbox', { name: 'SCIM token' })).toBeNull()
  })
})
