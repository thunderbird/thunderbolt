/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getClock } from '@/testing-library'
import type { Invitation, InvitationStatus, LinkReview } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { linkReview } from './link-review-fixtures'
import { makeMember } from './member-fixtures'
import { MembersPage } from './members-page'
import { adminItemLink } from '../../components/use-resource-page-state'
import { linkReviewEditId } from './link-review-rules'
import type { ComponentProps } from 'react'
import type { MemoryRouter } from 'react-router'

const invitation = (
  email: string,
  status: InvitationStatus,
  idpOverride = false,
  expiresAt = '2026-11-24T00:00:00.000Z',
): Invitation => ({
  id: `inv-${email.split('@')[0]}`,
  email,
  status,
  expiresAt,
  idpOverride,
  invitedBy: 'admin-1',
  createdAt: '2026-11-17T00:00:00.000Z',
})

/** The link reviews the backend holds; a test sets them before rendering. */
let reviews: LinkReview[] = []
/** Whether the backend pages pending reviews one at a time. */
let pagesReviews = false

const invitations = [
  invitation('pending@example.com', 'pending'),
  invitation('accepted@example.com', 'accepted'),
  invitation('revoked@example.com', 'revoked'),
]

/** Whether an invitation matches the `expired` filter, by the (fake) clock. */
const matchesExpiry = (item: Invitation, expired: string | null) =>
  expired === null || Date.parse(item.expiresAt) <= Date.now() === (expired === 'true')

/** Pending reviews one per page, by index cursor, when `pagesReviews` is on. */
const reviewPage = (matching: LinkReview[], cursor: string | null) => {
  if (!pagesReviews) {
    return { reviews: matching, nextCursor: null }
  }
  const index = Number(cursor ?? 0)
  return { reviews: matching.slice(index, index + 1), nextCursor: index + 1 < matching.length ? `${index + 1}` : null }
}

/**
 * One member, link reviews and invitations by status, each searched by `q`. A create to
 * `corp.example` is refused as claimed by an IdP unless it carries the override.
 */
const backend = ({ method, path, search, body }: FakeRequest): FakeReply => {
  const q = search.get('q') ?? ''
  if (method === 'GET' && path === 'admin/members') {
    return { body: { items: [makeMember()].filter((member) => member.email.includes(q)), nextCursor: null } }
  }
  if (method === 'GET' && path === 'admin/link-reviews') {
    const matching = reviews.filter(
      (review) => review.status === search.get('status') && review.incomingEmail.includes(q),
    )
    return { body: reviewPage(matching, search.get('cursor')) }
  }
  if (method === 'GET' && path === 'admin/invitations') {
    const items = invitations.filter(
      (item) =>
        item.status === search.get('status') && item.email.includes(q) && matchesExpiry(item, search.get('expired')),
    )
    return { body: { items, nextCursor: null } }
  }
  if (method === 'GET' && path === `admin/members/${makeMember().userId}`) {
    return { body: makeMember() }
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
  if (path.endsWith('/block') || path.endsWith('/unblock')) {
    return { body: { ...makeMember(), warning: path.endsWith('/block') ? 'NO_LOCAL_ADMIN' : undefined } }
  }
  const { email, idpOverride } = body as { email: string; idpOverride?: boolean }
  if (email.endsWith('@corp.example') && !idpOverride) {
    return { status: 409, body: { code: 'DOMAIN_CLAIMED_BY_IDP' } }
  }
  return { body: invitation(email, 'pending', Boolean(idpOverride)) }
}

/** A list row: its button, plus the badges beside it. */
const row = (name: string) => screen.getByRole('button', { name: `Open ${name}` }).parentElement!

const renderPage = async (
  initialEntries: ComponentProps<typeof MemoryRouter>['initialEntries'] = ['/admin/members'],
) => {
  const harness = createAdminTestHarness(backend, { initialEntries })
  render(<MembersPage />, { wrapper: harness.wrapper })
  await flush()
  return harness
}

const invite = async (email: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Invite Member' }))
  await flush()
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
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
    pagesReviews = false
  })

  /** A panel's ⋯ menu item; the panel's menu is the only ⋯ on the page. */
  const choosePanelItem = async (name: string) => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name }))
    await flush()
  }

  it('lists what waits for an admin, then the members, then what is closed, dimmed, in one list with badges', async () => {
    reviews = [
      linkReview({ id: 'r1', incomingEmail: 'ada@gmail.com' }),
      linkReview({ id: 'r2', incomingEmail: 'bob@corp.example', status: 'rejected' }),
    ]
    invitations.push(invitation('old@example.com', 'pending', false, '2026-11-10T00:00:00.000Z'))
    await renderPage()
    invitations.pop()

    const order = screen.getAllByRole('button', { name: /^Open / }).map((button) => button.getAttribute('aria-label'))
    expect(order).toEqual([
      'Open link review for ada@gmail.com',
      'Open pending@example.com',
      'Open Ada Lovelace',
      'Open link review for bob@corp.example',
      'Open old@example.com',
      'Open revoked@example.com',
    ])
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
    expect(within(row('link review for ada@gmail.com')).getByText('Review pending')).toBeInTheDocument()
    expect(within(row('pending@example.com')).getByText('Invited')).toBeInTheDocument()
    expect(within(row('pending@example.com')).getByText(/^Expires /)).toBeInTheDocument()
    expect(within(row('link review for bob@corp.example')).getByText('Rejected')).toBeInTheDocument()
    expect(within(row('old@example.com')).getByText('Expired')).toBeInTheDocument()
    expect(within(row('revoked@example.com')).getByText('Revoked')).toBeInTheDocument()
    expect(within(row('revoked@example.com')).getByText(/^Invited /)).toBeInTheDocument()
    expect(screen.queryByText('accepted@example.com')).not.toBeInTheDocument()
  })

  it('pages through the pending reviews before the members, with one Load more', async () => {
    pagesReviews = true
    reviews = [
      linkReview({ id: 'r1', incomingEmail: 'ada@gmail.com' }),
      linkReview({ id: 'r2', incomingEmail: 'bob@corp.example' }),
    ]
    await renderPage()

    const order = () =>
      screen.getAllByRole('button', { name: /^Open / }).map((button) => button.getAttribute('aria-label'))
    expect(order()).toEqual(['Open link review for ada@gmail.com'])
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await flush()

    expect(order()).toEqual([
      'Open link review for ada@gmail.com',
      'Open link review for bob@corp.example',
      'Open pending@example.com',
      'Open Ada Lovelace',
      'Open revoked@example.com',
    ])
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('has no header menu: the page header holds only search and invite', async () => {
    await renderPage()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('searches invitations with the members', async () => {
    const harness = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search members'), { target: { value: 'pend' } })
    // The search waits out its debounce, then fetches.
    await flush()
    await flush()

    const searched = harness.requests.filter((request) => request.search.get('q') === 'pend')
    expect(searched.map((request) => request.path).sort()).toEqual([
      'admin/invitations',
      'admin/invitations',
      'admin/invitations',
      'admin/link-reviews',
      'admin/link-reviews',
      'admin/members',
    ])
    expect(screen.getByRole('button', { name: 'Open pending@example.com' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Ada Lovelace' })).not.toBeInTheDocument()
  })

  it('shows one no-results line when nothing matches the search', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search members'), { target: { value: 'nobody' } })
    await flush()
    await flush()

    expect(screen.getAllByText('No matching members.')).toHaveLength(1)
  })

  it('says a pending invitation past its expiry has expired', async () => {
    getClock().setSystemTime(new Date('2026-11-30T00:00:00.000Z'))
    await renderPage()
    expect(within(row('pending@example.com')).getByText(/^Expired /)).toBeInTheDocument()

    cleanup()
    getClock().setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    await renderPage()
    expect(within(row('pending@example.com')).getByText(/^Expires /)).toBeInTheDocument()
  })

  it('opens an invitation and revokes it after a confirm, keeping its panel open', async () => {
    const harness = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Open pending@example.com' }))
    await flush()
    await choosePanelItem('Revoke')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke invitation' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')?.path).toBe(
      'admin/invitations/inv-pending/revoke',
    )
    expect(screen.getByRole('heading', { name: 'pending@example.com' })).toBeInTheDocument()
  })

  it("revokes an invitation from its row's context menu", async () => {
    const harness = await renderPage()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open pending@example.com' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Revoke' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke invitation' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')?.path).toBe(
      'admin/invitations/inv-pending/revoke',
    )
  })

  it("opens a member's edit form from their row's context menu", async () => {
    await renderPage()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Ada Lovelace' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    await flush()

    expect(screen.getByRole('heading', { name: 'Edit Member' })).toBeInTheDocument()
  })

  it("blocks a member with a reason from their row's context menu, and warns when no local admin is left", async () => {
    const harness = await renderPage()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Ada Lovelace' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Block' }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Left the company' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block member' }))
    await flush()

    expect(harness.requests.find((request) => request.path.endsWith('/block'))).toMatchObject({
      method: 'POST',
      path: 'admin/members/user-1/block',
      body: { reason: 'Left the company' },
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByText('No admin can sign in without your identity provider')).toBeInTheDocument()
  })

  it("offers a member's row the same actions as their panel", async () => {
    await renderPage()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Ada Lovelace' }))
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent)
    expect(items).toEqual(['Edit', 'Block'])
  })

  it('invites an address from Members, then opens the new invitation', async () => {
    const harness = await renderPage()

    await invite('new@example.com')

    expect(creates(harness)).toMatchObject([{ body: { email: 'new@example.com' } }])
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
  })

  it('drops the override offer when the address changes', async () => {
    await renderPage()
    await invite('ada@corp.example')
    expect(screen.getByRole('button', { name: 'Invite anyway' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bob@example.com' } })

    expect(screen.queryByRole('button', { name: 'Invite anyway' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite' })).toBeEnabled()
  })

  describe('identities waiting to be linked', () => {
    const okta = linkReview({ id: 'r1', incomingEmail: 'ada@gmail.com' })
    const keycloak = linkReview({
      id: 'r2',
      incomingEmail: 'bob@corp.example',
      connection: { id: 'c2', name: 'Keycloak' },
    })

    it('lists no decided review', async () => {
      reviews = [{ ...okta, status: 'approved' }]
      await renderPage()

      expect(screen.queryByRole('button', { name: 'Open link review for ada@gmail.com' })).toBeNull()
    })

    it('lists the reviews with their connection, and opens one from its row', async () => {
      reviews = [okta, keycloak]
      await renderPage()

      expect(within(row('link review for bob@corp.example')).getByText(/^Keycloak · /)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Open link review for ada@gmail.com' }))
      await flush()
      expect(screen.getByRole('heading', { name: 'ada@gmail.com', level: 2 })).toBeInTheDocument()
    })

    it('searches the reviews with the members', async () => {
      reviews = [okta, keycloak]
      await renderPage()

      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      fireEvent.change(screen.getByPlaceholderText('Search members'), { target: { value: 'bob' } })
      await flush()
      await flush()

      expect(screen.getByRole('button', { name: 'Open link review for bob@corp.example' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Open link review for ada@gmail.com' })).toBeNull()
    })

    it("opens a review from its link, and it leaves the list once it's decided", async () => {
      reviews = [okta]
      const link = adminItemLink('/admin/members', linkReviewEditId('r1'))
      await renderPage([{ pathname: link.to, state: link.state }])

      expect(screen.getByRole('heading', { name: 'ada@gmail.com', level: 2 })).toBeInTheDocument()

      await choosePanelItem('Approve')
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }))
      await flush()

      expect(screen.queryByRole('heading', { name: 'ada@gmail.com', level: 2 })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open link review for ada@gmail.com' })).toBeNull()
    })

    it('lists rejected reviews dimmed, and approving one from its row undoes the rejection', async () => {
      reviews = [{ ...okta, status: 'rejected' }]
      await renderPage()
      expect(within(row('link review for ada@gmail.com')).getByText('Rejected')).toBeInTheDocument()

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Open link review for ada@gmail.com' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve' }))
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }))
      await flush()

      expect(reviews[0].status).toBe('approved')
    })
  })
})
