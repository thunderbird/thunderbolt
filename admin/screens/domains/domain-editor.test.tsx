/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnection, OrgDomain } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { DomainsPage } from './domains-page'
import { makeConnection, makeDomain } from './fixtures'

const verifiedAt = '2026-11-17T01:00:00.000Z'
const okta = makeConnection()

type Backend = {
  domain: OrgDomain
  connections?: AdminConnection[]
  /** The DNS check's result: null passes. */
  check?: string | null
  /** Answers a change instead of the stateful backend. */
  refuse?: (request: FakeRequest) => FakeReply | undefined
}

/** A backend holding one domain, applying each change the way the real one does. */
const createBackend = ({ domain, connections = [okta], check = null, refuse }: Backend) => {
  const state = { domain }
  const respond = (request: FakeRequest): FakeReply => {
    const { method, path } = request
    if (method === 'GET' && path === 'admin/domains') {
      return { body: { items: [state.domain] } }
    }
    if (method === 'GET' && path === 'admin/connections') {
      return { body: { items: connections } }
    }
    const refusal = refuse?.(request)
    if (refusal) {
      return refusal
    }
    const current = state.domain
    if (path.endsWith('/verify')) {
      state.domain = {
        ...current,
        lastCheckedAt: verifiedAt,
        lastCheckError: check,
        verifiedAt: check ? current.verifiedAt : (current.verifiedAt ?? verifiedAt),
      }
    } else if (path.endsWith('/enrollment')) {
      state.domain = { ...current, enrollmentEnabled: (request.body as { enabled: boolean }).enabled }
    } else if (path.endsWith('/claim') && method === 'PUT') {
      const id = (request.body as { identityConnectionId: string }).identityConnectionId
      const connection = connections.find((item) => item.id === id)!
      state.domain = { ...current, claimedBy: { id, name: connection.name }, enrollmentEnabled: false }
    } else if (path.endsWith('/claim') && method === 'DELETE') {
      state.domain = { ...current, claimedBy: null }
    } else if (method === 'DELETE') {
      return { status: 204 }
    }
    return { body: state.domain }
  }
  return createAdminTestHarness(respond)
}

/** Opens the domain's panel from its row. */
const openDomain = async (harness: ReturnType<typeof createAdminTestHarness>, name = 'example.com') => {
  render(<DomainsPage />, { wrapper: harness.wrapper })
  await flush()
  fireEvent.click(screen.getByRole('button', { name }))
  await flush()
}

const click = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }))
  await flush()
}

const enrollmentSwitch = () => screen.getByRole('switch', { name: 'Open to enrollment' })

const openPicker = () => {
  const trigger = screen.getByRole('combobox', { name: 'Identity provider' })
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
}

const chooseConnection = async (name: RegExp) => {
  openPicker()
  const option = screen.getByRole('option', { name })
  fireEvent.pointerUp(option, { button: 0, pointerId: 1 })
  fireEvent.click(option)
  await flush()
}

const changes = (harness: ReturnType<typeof createAdminTestHarness>) =>
  harness.requests.filter((request) => request.method !== 'GET')

describe('DomainEditor', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('takes a domain from added to verified to claimed, closing enrollment with the reason', async () => {
    const harness = createBackend({ domain: makeDomain() })
    await openDomain(harness)

    expect(enrollmentSwitch()).toBeDisabled()
    expect(enrollmentSwitch()).toHaveAccessibleDescription(/Verify this domain before opening it to enrollment\./)

    await click('Verify')
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0)
    expect(enrollmentSwitch()).toBeEnabled()

    fireEvent.click(enrollmentSwitch())
    await flush()
    expect(enrollmentSwitch()).toBeChecked()

    await chooseConnection(/^Okta/)
    await click('Claim')

    expect(changes(harness).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'POST', path: 'admin/domains/d1/verify', body: undefined },
      { method: 'PUT', path: 'admin/domains/d1/enrollment', body: { enabled: true } },
      { method: 'PUT', path: 'admin/domains/d1/claim', body: { identityConnectionId: 'c1' } },
    ])
    expect(enrollmentSwitch()).not.toBeChecked()
    expect(enrollmentSwitch()).toBeDisabled()
    expect(enrollmentSwitch()).toHaveAccessibleDescription(
      /Okta claims this domain, so people on it sign in through that identity provider\./,
    )
    expect(screen.getByRole('link', { name: 'Okta' })).toHaveAttribute('href', '/admin/identity-providers?edit=c1')
  })

  it.each([
    ['TXT_RECORD_NOT_FOUND', 'No verification record was found. DNS changes can take a while to appear.'],
    ['TXT_RECORD_MISMATCH', "A verification record was found, but its value doesn't match."],
    ['DNS_LOOKUP_FAILED', 'The DNS lookup failed. Try again later.'],
    ['SOMETHING_NEW', 'SOMETHING_NEW'],
  ])('shows why verification failed: %s', async (check, message) => {
    const harness = createBackend({ domain: makeDomain(), check })
    await openDomain(harness)

    await click('Verify')

    expect(screen.getByText('The last check failed')).toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getAllByText('Unverified').length).toBeGreaterThan(0)
    expect(enrollmentSwitch()).toBeDisabled()
  })

  it('keeps a verified domain verified when a later check fails', async () => {
    const harness = createBackend({ domain: makeDomain({ verifiedAt }), check: 'TXT_RECORD_NOT_FOUND' })
    await openDomain(harness)

    await click('Check again')

    expect(screen.getByText('The last check failed')).toBeInTheDocument()
    expect(screen.getAllByText('Verified').length).toBeGreaterThan(0)
    expect(enrollmentSwitch()).toBeEnabled()
  })

  it('locks the claim picker until the domain is verified', async () => {
    await openDomain(createBackend({ domain: makeDomain() }))

    expect(screen.getByRole('combobox', { name: 'Identity provider' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Claim' })).toBeDisabled()
    expect(screen.getByText('Verify this domain before an identity provider can claim it.')).toBeInTheDocument()
  })

  it('offers every connection but retired ones, with what each does', async () => {
    const connections = [
      okta,
      makeConnection({ id: 'c2', name: 'Entra', scim: { scimConnectionId: 's2' } }),
      makeConnection({ id: 'c3', name: 'Directory', sso: null, scim: { scimConnectionId: 's3' } }),
      makeConnection({ id: 'c4', name: 'Old', status: 'retired' }),
    ]
    await openDomain(createBackend({ domain: makeDomain({ verifiedAt }), connections }))

    openPicker()

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'OktaSSO',
      'EntraSSO + SCIM',
      'DirectorySCIM',
    ])
  })

  it('points to the identity providers when none can claim', async () => {
    await openDomain(createBackend({ domain: makeDomain({ verifiedAt }), connections: [] }))

    expect(screen.getByRole('link', { name: 'Add an identity provider' })).toHaveAttribute(
      'href',
      '/admin/identity-providers',
    )
    expect(screen.queryByRole('combobox', { name: 'Identity provider' })).not.toBeInTheDocument()
  })

  it('releases a claim and leaves enrollment closed but open to change', async () => {
    const harness = createBackend({ domain: makeDomain({ verifiedAt, claimedBy: { id: 'c1', name: 'Okta' } }) })
    await openDomain(harness)
    expect(enrollmentSwitch()).toBeDisabled()

    await click('Release claim')

    expect(changes(harness).at(-1)).toMatchObject({ method: 'DELETE', path: 'admin/domains/d1/claim' })
    expect(enrollmentSwitch()).not.toBeChecked()
    expect(enrollmentSwitch()).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Identity provider' })).toBeEnabled()
  })

  it('shows a refused enrollment change and refetches the domain', async () => {
    const harness = createBackend({
      domain: makeDomain({ verifiedAt }),
      refuse: ({ path }) =>
        path.endsWith('/enrollment') ? { status: 409, body: { code: 'DOMAIN_CLAIMED_BY_IDP' } } : undefined,
    })
    await openDomain(harness)

    fireEvent.click(enrollmentSwitch())
    await flush()

    expect(screen.getByRole('alert')).toHaveTextContent('An identity provider claims this domain.')
    expect(
      harness.requests.filter((request) => request.method === 'GET' && request.path === 'admin/domains'),
    ).toHaveLength(2)
  })

  it('says each subdomain is claimed on its own', async () => {
    await openDomain(createBackend({ domain: makeDomain({ verifiedAt }) }))

    expect(
      screen.getByText(
        'A claim covers example.com only. Subdomains such as mail.example.com are never trusted automatically: add, verify and claim each one on its own.',
      ),
    ).toBeInTheDocument()
  })

  it('removes an unclaimed domain after confirmation', async () => {
    const harness = createBackend({ domain: makeDomain() })
    await openDomain(harness)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, pointerId: 1 })
    await flush()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove domain' }))
    await flush()
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Remove example.com?')
    await click('Remove domain')

    expect(changes(harness).at(-1)).toMatchObject({ method: 'DELETE', path: 'admin/domains/d1' })
    expect(screen.queryByRole('button', { name: 'example.com' })).not.toBeInTheDocument()
  })

  it('does not offer to remove a claimed domain', async () => {
    await openDomain(createBackend({ domain: makeDomain({ verifiedAt, claimedBy: { id: 'c1', name: 'Okta' } }) }))

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, pointerId: 1 })
    await flush()

    expect(screen.getByRole('menuitem', { name: 'Remove domain' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Release the claim before removing this domain.')).toBeInTheDocument()
  })
})
