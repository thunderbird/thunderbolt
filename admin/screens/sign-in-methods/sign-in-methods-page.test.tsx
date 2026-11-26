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
import { adminItemLink } from '../../components/use-resource-page-state'
import type { ComponentProps } from 'react'
import type { MemoryRouter } from 'react-router'

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

const renderPage = async (
  respond: (request: FakeRequest) => FakeReply,
  initialEntries?: ComponentProps<typeof MemoryRouter>['initialEntries'],
) => {
  const harness = createAdminTestHarness(respond, initialEntries ? { initialEntries } : undefined)
  render(<SignInMethodsPage />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

/** Start a new sign-in method from the header, or from the empty state when nothing is listed yet. */
const addSignInMethod = (kind: string) => {
  fireEvent.click(
    screen.queryByRole('button', { name: 'New Sign-in Method' }) ??
      screen.getByRole('button', { name: 'Add your first sign-in method' }),
  )
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${kind}`) }))
}

const fillOidcForm = () => {
  addSignInMethod('OIDC single sign-on')
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

  it('lists connections and domains together by name, with retired connections under their own label', async () => {
    await renderPage(backend(connections, domains))

    const names = screen
      .getAllByRole('button', { pressed: false })
      .map((button) => button.getAttribute('aria-label'))
      .filter(Boolean)
    expect(names).toEqual([
      'Open Acme Entra',
      'Open example.com',
      'Open open.test',
      'Open SSO',
      'Open sso.test',
      'Open Old',
    ])
    expect(screen.getByRole('heading', { name: 'Retired' })).toBeInTheDocument()
  })

  it('narrows the list by name, and says when nothing matches', async () => {
    await renderPage(backend(connections, domains))

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search sign-in methods'), { target: { value: 'acme' } })
    await flush()
    expect(screen.getByRole('button', { name: 'Open Acme Entra' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open SSO' })).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('Search sign-in methods'), { target: { value: 'zzz' } })
    await flush()
    expect(screen.getByText('No matching sign-in methods.')).toBeInTheDocument()
  })

  it('describes each connection by its sign-in, provisioning and domains, badging only what needs a flag', async () => {
    await renderPage(backend([{ ...connections[0], claimedDomains: ['corp.test'] }, ...connections.slice(1)]))

    const env = screen.getByRole('button', { name: 'Open SSO' })
    expect(env).toHaveTextContent('OIDC · Set by server settings · corp.test')
    expect(env).not.toHaveTextContent('Active')
    const acme = screen.getByRole('button', { name: 'Open Acme Entra' })
    expect(acme).toHaveTextContent('SAML · SCIM')
    expect(acme).toHaveTextContent('Retiring')
  })

  it('describes each domain by what it does, badging only an unverified one', async () => {
    await renderPage(backend([], domains))

    const row = (name: string) => within(screen.getByRole('button', { name: `Open ${name}` }))
    expect(row('example.com').getByText('Unverified')).toBeInTheDocument()
    expect(row('open.test').getByText('Open to enrollment')).toBeInTheDocument()
    expect(row('open.test').queryByText('Verified')).toBeNull()
    expect(row('sso.test').getByText('Claimed by Okta')).toBeInTheDocument()
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

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
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

  it('keeps the provider ID to lowercase letters, digits and hyphens as it is typed', async () => {
    await renderPage(backend([], []))
    addSignInMethod('OIDC single sign-on')
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'Acme Okta_1' } })

    expect(screen.getByLabelText('Provider ID')).toHaveValue('acmeokta1')
  })

  it('explains the match claim behind the info icon beside its label', async () => {
    await renderPage(backend([], []))
    addSignInMethod('OIDC single sign-on')
    fireEvent.focus(screen.getByRole('button', { name: 'What is this for?' }))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      "Must hold the person's SCIM externalId. Locks after the first sign-in.",
    )
  })

  it("opens a connection's edit form from its row's context menu, and Cancel goes back to its view", async () => {
    const own: AdminConnection = { ...created, id: 'c3' }
    await renderPage(backend([own], [], () => ({ body: created })))

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Okta' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    await flush()
    expect(screen.getByRole('heading', { name: 'Edit Connection' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await flush()
    expect(screen.queryByRole('heading', { name: 'Edit Connection' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Okta' })).toBeInTheDocument()
  })

  it('retires a connection after confirming, and offers no retire while SCIM is active', async () => {
    const own: AdminConnection = { ...created, id: 'c3' }
    const withScim: AdminConnectionDetail = { ...created, id: 'c4', name: 'Both', scim: { scimConnectionId: 's4' } }
    const harness = await renderPage(
      backend([own, withScim], [], ({ path }) =>
        path === 'admin/connections/c4' ? { body: withScim } : { body: created },
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Both' }))
    await flush()
    expect(screen.getByText('To retire this connection, retire its SCIM provisioning first.')).toBeInTheDocument()
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
    })
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Retire' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Open Okta' }))
    await flush()
    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retire' }))
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
    addSignInMethod('SCIM provisioning')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Okta SCIM' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await flush()

    expect(harness.requests.find((request) => request.path === 'admin/connections/scim')?.body).toEqual({
      name: 'Okta SCIM',
    })
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-9')

    // Closing before Done asks first, so the token isn't dropped unseen.
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    await flush()
    expect(screen.getByText('Leave without copying the token?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await flush()
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-9')

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await flush()
    expect(screen.queryByRole('textbox', { name: 'SCIM token' })).toBeNull()
  })

  it('opens a domain from its card and shows the record to publish', async () => {
    await renderPage(backend([], domains))

    fireEvent.click(screen.getByRole('button', { name: 'Open example.com' }))
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
    fireEvent.click(within(input.closest('form')!).getByRole('button', { name: 'Add' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')?.body).toEqual({ domain: 'acme.test' })
    expect(screen.getByRole('heading', { name: 'acme.test' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Record name' })).toHaveValue('_thunderbolt-verification.acme.test')
  })

  it('opens nothing for an id that matches no domain', async () => {
    const link = adminItemLink('/admin/sign-in-methods', 'domain:gone')
    await renderPage(backend([], domains), [{ pathname: link.to, state: link.state }])

    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open example.com' })).toHaveAttribute('aria-pressed', 'false')
  })
})
