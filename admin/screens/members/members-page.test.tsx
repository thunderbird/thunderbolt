/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import type { Invitation, InvitationStatus, LinkReview } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { linkReview } from './link-review-fixtures'
import { makeMember } from './member-fixtures'
import { MembersPage } from './members-page'

const invitation = (email: string, status: InvitationStatus, idpOverride = false): Invitation => ({
  id: `inv-${email.split('@')[0]}`,
  email,
  status,
  expiresAt: '2026-11-24T00:00:00.000Z',
  idpOverride,
  invitedBy: 'admin-1',
  createdAt: '2026-11-17T00:00:00.000Z',
})

/** The link reviews the backend holds; a test sets them before rendering. */
let reviews: LinkReview[] = []

const invitations = [
  invitation('pending@example.com', 'pending'),
  invitation('accepted@example.com', 'accepted'),
  invitation('revoked@example.com', 'revoked'),
]

/**
 * One member and invitations by status, each searched by `q`. A create to `corp.example` is refused
 * as claimed by an IdP unless it carries the override.
 */
const backend = ({ method, path, search, body }: FakeRequest): FakeReply => {
  const q = search.get('q') ?? ''
  if (method === 'GET' && path === 'admin/members') {
    return { body: { items: [makeMember()].filter((member) => member.email.includes(q)), nextCursor: null } }
  }
  if (method === 'GET' && path === 'admin/link-reviews') {
    return { body: { reviews: reviews.filter((review) => review.status === search.get('status')), nextCursor: null } }
  }
  if (method === 'GET' && path === 'admin/invitations') {
    const items = invitations.filter((item) => item.status === search.get('status') && item.email.includes(q))
    return { body: { items, nextCursor: null } }
  }
  if (method === 'GET') {
    return { status: 404, body: {} }
  }
  const decided = path.match(/^admin\/link-reviews\/(.+)\/(approve|reject)$/)
  if (decided) {
    const [, id, decision] = decided
    reviews = reviews.map((review) =>
      review.id === id ? { ...review, status: decision === 'approve' ? 'approved' : 'rejected' } : review,
    )
    return { body: reviews.find((review) => review.id === id) }
  }
  if (path.endsWith('/revoke')) {
    return { status: 204 }
  }
  const { email, idpOverride } = body as { email: string; idpOverride?: boolean }
  if (email.endsWith('@corp.example') && !idpOverride) {
    return { status: 409, body: { code: 'DOMAIN_CLAIMED_BY_IDP' } }
  }
  return { body: invitation(email, 'pending', Boolean(idpOverride)) }
}

/** A list row: its button, plus the badges beside it. */
const row = (name: string) => screen.getByRole('button', { name }).parentElement!

const renderPage = async (initialEntries = ['/admin/members']) => {
  const harness = createAdminTestHarness(backend, { initialEntries })
  render(<MembersPage />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

const invite = async (email: string) => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Invite member' })[0])
  await flush()
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }))
  await flush()
}

const creates = (harness: Awaited<ReturnType<typeof renderPage>>) =>
  harness.requests.filter((request) => request.method === 'POST' && request.path === 'admin/invitations')

describe('MembersPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  // Before the fixtures' expiry, so they read as pending; the expiry test moves the clock itself.
  beforeEach(() => {
    getClock().setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
  })
  afterEach(() => {
    cleanup()
    reviews = []
  })

  it('lists pending invitations with their expiry and no status badge, and no accepted or revoked ones', async () => {
    await renderPage()

    expect(within(row('pending@example.com')).getByText(/^Invitation expires/)).toBeInTheDocument()
    expect(within(row('pending@example.com')).queryByText('Pending')).toBeNull()
    expect(screen.getByRole('button', { name: 'Ada Lovelace' })).toBeInTheDocument()
    expect(screen.queryByText('accepted@example.com')).not.toBeInTheDocument()
    expect(screen.queryByText('revoked@example.com')).not.toBeInTheDocument()
  })

  it('shows revoked invitations from the "More" menu', async () => {
    await renderPage(['/admin/members?revoked=1'])

    expect(within(row('revoked@example.com')).getByText('Revoked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invitations 1 1 revoked' })).toBeInTheDocument()
  })

  it('hides the revoked invitations again when the option is turned off', async () => {
    await renderPage(['/admin/members?revoked=1'])
    expect(screen.getByRole('button', { name: 'revoked@example.com' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show revoked invitations' }))
    await flush()

    expect(screen.queryByRole('button', { name: 'revoked@example.com' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pending@example.com' })).toBeInTheDocument()
  })

  it('searches invitations with the members', async () => {
    const harness = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search members' }), { target: { value: 'pend' } })
    await flush()

    const searched = harness.requests.filter((request) => request.search.get('q') === 'pend')
    expect(searched.map((request) => request.path).sort()).toEqual(['admin/invitations', 'admin/members'])
    expect(screen.getByRole('button', { name: 'pending@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ada Lovelace' })).not.toBeInTheDocument()
  })

  it('says a pending invitation past its expiry has expired', async () => {
    getClock().setSystemTime(new Date('2026-11-30T00:00:00.000Z'))
    await renderPage()
    expect(within(row('pending@example.com')).getByText(/^Invitation expired /)).toBeInTheDocument()
    expect(within(row('pending@example.com')).getByText('Expired')).toBeInTheDocument()

    cleanup()
    getClock().setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    await renderPage()
    expect(within(row('pending@example.com')).getByText(/^Invitation expires /)).toBeInTheDocument()
  })

  it('opens an invitation and revokes it after a confirm', async () => {
    const harness = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'pending@example.com' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke invitation' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')?.path).toBe(
      'admin/invitations/inv-pending/revoke',
    )
    expect(screen.getByText('Invitation to pending@example.com revoked.')).toBeInTheDocument()
  })

  it('invites an address from Members, then says it was sent', async () => {
    const harness = await renderPage()

    await invite('new@example.com')

    expect(creates(harness)).toMatchObject([{ body: { email: 'new@example.com' } }])
    expect(screen.getByText('Invitation sent to new@example.com.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  })

  it('refuses an address on a domain an IdP claims, unless the admin invites it anyway', async () => {
    const harness = await renderPage()

    await invite('ada@corp.example')

    expect(creates(harness)).toHaveLength(1)
    expect(creates(harness)[0].body).toEqual({ email: 'ada@corp.example' })
    expect(screen.getByText('An identity provider manages this domain')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Invite anyway' }))
    await flush()

    expect(creates(harness)[1].body).toEqual({ email: 'ada@corp.example', idpOverride: true })
    expect(screen.getByText('Invitation sent to ada@corp.example.')).toBeInTheDocument()
  })

  it('drops the override offer when the address changes', async () => {
    await renderPage()
    await invite('ada@corp.example')
    expect(screen.getByRole('button', { name: 'Invite anyway' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bob@example.com' } })

    expect(screen.queryByRole('button', { name: 'Invite anyway' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeInTheDocument()
  })

  it('labels an invitation that used the override', async () => {
    invitations.push(invitation('override@corp.example', 'pending', true))
    await renderPage()

    expect(within(row('override@corp.example')).getByText('IdP override')).toBeInTheDocument()
    invitations.pop()
  })

  describe('identities waiting to be linked', () => {
    const okta = linkReview({ id: 'r1', incomingEmail: 'ada@gmail.com' })
    const keycloak = linkReview({
      id: 'r2',
      incomingEmail: 'bob@corp.example',
      connection: { id: 'c2', name: 'Keycloak' },
    })

    it('shows every section open, with an empty state when nothing waits to be linked', async () => {
      reviews = [{ ...okta, status: 'approved' }]
      await renderPage()

      const links = screen.getByRole('button', { name: 'Waiting to be linked' })
      expect(links).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: /^Invitations/ })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: 'Members' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('Nothing waiting to be linked')).toBeInTheDocument()
    })

    it('shows an empty state for invitations and members that match nothing', async () => {
      await renderPage()
      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search members' }), { target: { value: 'nobody' } })
      await flush()

      expect(screen.getByText('No matching invitations')).toBeInTheDocument()
      expect(screen.getByText('No matching members')).toBeInTheDocument()
    })

    it('shows the count, opens a review from its row, and folds the rows away from its title', async () => {
      reviews = [okta, keycloak]
      await renderPage()

      fireEvent.click(screen.getByRole('button', { name: 'ada@gmail.com' }))
      await flush()
      expect(screen.getByRole('heading', { name: 'ada@gmail.com' })).toBeInTheDocument()

      const header = screen.getByRole('button', { name: 'Waiting to be linked 2' })
      fireEvent.click(header)
      expect(header).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'bob@corp.example' })).toBeNull()
    })

    it("opens a review from its link, and it leaves the list once it's decided", async () => {
      reviews = [okta]
      await renderPage(['/admin/members?edit=link:r1'])

      expect(screen.getByRole('heading', { name: 'ada@gmail.com' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }))
      await flush()

      expect(screen.queryByRole('heading', { name: 'ada@gmail.com' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Waiting to be linked' })).toBeInTheDocument()
    })

    it('lists rejected reviews from the ⋯ menu, and approving one undoes the rejection', async () => {
      reviews = [{ ...okta, status: 'rejected' }]
      await renderPage()
      expect(screen.getByRole('button', { name: 'Waiting to be linked' })).toBeInTheDocument()

      await act(async () => {
        fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 })
      })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Show rejected links' }))
      await flush()
      expect(screen.getByRole('button', { name: 'Waiting to be linked 1 rejected' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'ada@gmail.com' }))
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }))
      await flush()

      expect(reviews[0].status).toBe('approved')
      expect(screen.queryByText('1 rejected')).toBeNull()
    })
  })
})
