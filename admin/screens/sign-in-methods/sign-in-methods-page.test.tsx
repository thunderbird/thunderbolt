/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnection, AdminConnectionDetail, OrgDomain } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { makeDomain } from '../domains/fixtures'
import { SignInMethodsPage } from './sign-in-methods-page'

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

const domains = [
  makeDomain(),
  makeDomain({ id: 'd2', domain: 'open.test', verifiedAt: '2026-11-17T01:00:00.000Z', enrollmentEnabled: true }),
  makeDomain({
    id: 'd3',
    domain: 'sso.test',
    verifiedAt: '2026-11-17T01:00:00.000Z',
    claimedBy: { id: 'c1', name: 'Okta' },
  }),
]

/** Connections and domains to list; every other request goes to `other`, or answers with the created connection. */
const backend =
  (
    list: AdminConnection[],
    domainList: OrgDomain[] = [],
    other: (request: FakeRequest) => FakeReply = () => ({ body: created }),
  ) =>
  (request: FakeRequest): FakeReply => {
    if (request.method === 'GET' && request.path === 'admin/connections') {
      return { body: { items: list } }
    }
    if (request.method === 'GET' && request.path === 'admin/domains') {
      return { body: { items: domainList } }
    }
    return other(request)
  }

const renderPage = async (respond: (request: FakeRequest) => FakeReply, initialEntries?: string[]) => {
  const harness = createAdminTestHarness(respond, initialEntries ? { initialEntries } : undefined)
  render(<SignInMethodsPage />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

const addSignInMethod = (kind: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add sign-in method' }))
  fireEvent.click(screen.getByRole('button', { name: kind }))
}

const fillOidcForm = () => {
  addSignInMethod('Single sign-on with OIDC')
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

describe('SignInMethodsPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists connections and domains together, by name', async () => {
    await renderPage(backend(connections, domains))

    const names = screen
      .getAllByRole('button', { pressed: false })
      .map((button) => button.getAttribute('aria-label'))
      .filter(Boolean)
    expect(names).toEqual(['Acme Entra', 'example.com', 'Old', 'open.test', 'SSO', 'sso.test'])
  })

  it('describes each connection by its sign-in, provisioning, status and domains', async () => {
    await renderPage(backend([{ ...connections[0], claimedDomains: ['corp.test'] }, ...connections.slice(1)]))

    const env = screen.getByRole('button', { name: 'SSO' })
    expect(env).toHaveTextContent('OIDC sign-in · Set by server settings · corp.test')
    expect(env).toHaveTextContent('Active')
    const acme = screen.getByRole('button', { name: 'Acme Entra' })
    expect(acme).toHaveTextContent('SAML sign-in · SCIM retiring')
    expect(acme).toHaveTextContent('Retiring')
    expect(screen.getByRole('button', { name: 'Old' })).toHaveTextContent('Retired')
  })

  it('describes each domain by its status, and which provider signs its people in', async () => {
    await renderPage(backend([], domains))

    const row = (name: string) => within(screen.getByRole('button', { name }))
    expect(row('example.com').getByText('Unverified')).toBeInTheDocument()
    expect(row('example.com').getByText('Domain · Waiting for verification')).toBeInTheDocument()
    expect(row('open.test').getByText('Verified')).toBeInTheDocument()
    expect(row('open.test').getByText('Domain · Open to enrollment')).toBeInTheDocument()
    expect(row('sso.test').getByText('Claimed')).toBeInTheDocument()
    expect(row('sso.test').getByText('Domain · Signs people in through Okta')).toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    await renderPage(backend([]))
    expect(screen.getByText(/No sign-in methods yet/)).toBeInTheDocument()
  })

  it('shows why the list failed to load', async () => {
    await renderPage(() => ({ status: 403, body: { code: 'ADMIN_REQUIRED' } }))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('adds an OIDC connection and shows its redirect URI before saving', async () => {
    const harness = await renderPage(backend([]))
    fillOidcForm()
    expect((screen.getByRole('textbox', { name: 'Redirect URI' }) as HTMLInputElement).value).toMatch(
      /\/api\/auth\/sso\/callback\/okta$/,
    )

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
    await renderPage(
      backend([], [], ({ method, path }) =>
        method === 'POST' && path === 'admin/connections/sso'
          ? { status: 409, body: { code: 'SSO_PROVIDER_ID_TAKEN', message: 'taken' } }
          : { body: created },
      ),
    )
    fillOidcForm()
    fireEvent.submit(screen.getByLabelText('Provider ID').closest('form')!)
    await flush()

    expect(screen.getByLabelText('Provider ID')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('A connection with this provider ID already exists.')
  })

  it('retires a connection after confirming, and offers no retire while SCIM is active', async () => {
    const own: AdminConnection = { ...created, id: 'c3' }
    const withScim: AdminConnectionDetail = { ...created, id: 'c4', name: 'Both', scim: { scimConnectionId: 's4' } }
    const harness = await renderPage(
      backend([own, withScim], [], ({ path }) =>
        path === 'admin/connections/c4' ? { body: withScim } : { body: created },
      ),
    )

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
    const harness = await renderPage(
      backend([], [], ({ method, path }) =>
        method === 'POST' && path === 'admin/connections/scim'
          ? { body: { connection: { id: 'c9' }, credential, token: 'scim-token-9' } }
          : { body: created },
      ),
    )
    addSignInMethod('SCIM provisioning only')
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

  it('opens a domain from its card and shows the record to publish', async () => {
    await renderPage(backend([], domains))

    fireEvent.click(screen.getByRole('button', { name: 'example.com' }))
    await flush()

    expect(screen.getByRole('heading', { name: 'example.com' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Record name' })).toHaveValue('_thunderbolt-verification.example.com')
    expect(screen.getByRole('textbox', { name: 'Record value' })).toHaveValue('thunderbolt-verification=token')
  })

  it('adds a domain from the same "add" panel and lands on it', async () => {
    const added = makeDomain({
      id: 'd4',
      domain: 'acme.test',
      record: { name: '_thunderbolt-verification.acme.test', value: 'v' },
    })
    const harness = await renderPage(backend([], domains, () => ({ body: added })))

    addSignInMethod('Domain')
    await flush()
    const input = screen.getByRole('textbox', { name: 'Domain' })
    fireEvent.change(input, { target: { value: ' acme.test ' } })
    fireEvent.click(within(input.closest('form')!).getByRole('button', { name: 'Add domain' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')?.body).toEqual({ domain: 'acme.test' })
    expect(screen.getByRole('heading', { name: 'acme.test' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Record name' })).toHaveValue('_thunderbolt-verification.acme.test')
  })

  it('opens nothing for an id that matches no domain', async () => {
    await renderPage(backend([], domains), ['/admin/sign-in-methods?edit=domain:gone'])

    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'example.com' })).toHaveAttribute('aria-pressed', 'false')
  })
})
