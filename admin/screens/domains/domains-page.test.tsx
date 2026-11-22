/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { OrgDomain } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { DomainsPage } from './domains-page'
import { makeConnection, makeDomain } from './fixtures'

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

const backend =
  (items: OrgDomain[], other: (request: FakeRequest) => FakeReply = () => ({})) =>
  (request: FakeRequest): FakeReply => {
    if (request.method === 'GET' && request.path === 'admin/domains') {
      return { body: { items } }
    }
    if (request.method === 'GET' && request.path === 'admin/connections') {
      return { body: { items: [makeConnection()] } }
    }
    return other(request)
  }

const renderPage = async (harness: ReturnType<typeof createAdminTestHarness>) => {
  render(<DomainsPage />, { wrapper: harness.wrapper })
  await flush()
}

describe('DomainsPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists each domain with its status', async () => {
    await renderPage(createAdminTestHarness(backend(domains)))

    const row = (name: string) => within(screen.getByRole('button', { name }))
    expect(row('example.com').getByText('Unverified')).toBeInTheDocument()
    expect(row('example.com').getByText('Waiting for verification')).toBeInTheDocument()
    expect(row('open.test').getByText('Verified')).toBeInTheDocument()
    expect(row('open.test').getByText('Open to enrollment')).toBeInTheDocument()
    expect(row('sso.test').getByText('Claimed')).toBeInTheDocument()
    expect(row('sso.test').getByText('Claimed by Okta')).toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    await renderPage(createAdminTestHarness(backend([])))
    expect(screen.getByText('No domains yet')).toBeInTheDocument()
  })

  it('shows why the list failed to load', async () => {
    await renderPage(createAdminTestHarness(() => ({ status: 403, body: { code: 'ADMIN_REQUIRED' } })))
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('opens a domain from its row and shows the record to publish', async () => {
    await renderPage(createAdminTestHarness(backend(domains)))

    fireEvent.click(screen.getByRole('button', { name: 'example.com' }))
    await flush()

    expect(screen.getByRole('heading', { name: 'example.com' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Record name' })).toHaveValue('_thunderbolt-verification.example.com')
    expect(screen.getByRole('textbox', { name: 'Record value' })).toHaveValue('thunderbolt-verification=token')
  })

  it('opens the add form from the header and lands on the new domain', async () => {
    const added = makeDomain({
      id: 'd4',
      domain: 'acme.test',
      record: { name: '_thunderbolt-verification.acme.test', value: 'v' },
    })
    const harness = createAdminTestHarness(backend(domains, () => ({ body: added })))
    await renderPage(harness)

    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }))
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
    await renderPage(createAdminTestHarness(backend(domains), { initialEntries: ['/admin/domains?edit=gone'] }))

    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'example.com' })).toHaveAttribute('aria-pressed', 'false')
  })
})
