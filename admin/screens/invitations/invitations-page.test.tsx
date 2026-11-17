/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { Invitation, InvitationStatus } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { InvitationsPage } from './invitations-page'

const invitation = (email: string, status: InvitationStatus, idpOverride = false): Invitation => ({
  id: `inv-${email.split('@')[0]}`,
  email,
  status,
  expiresAt: '2026-11-24T00:00:00.000Z',
  idpOverride,
  invitedBy: 'admin-1',
  createdAt: '2026-11-17T00:00:00.000Z',
})

const invitations = [
  invitation('pending@example.com', 'pending'),
  invitation('accepted@example.com', 'accepted'),
  invitation('revoked@example.com', 'revoked'),
]

/**
 * Invitations by status. A create to `corp.example` is refused as claimed by an IdP unless it
 * carries the override.
 */
const backend = ({ method, path, search, body }: FakeRequest): FakeReply => {
  if (method === 'GET') {
    return { body: { items: invitations.filter((item) => item.status === search.get('status')), nextCursor: null } }
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

const renderPage = async () => {
  const harness = createAdminTestHarness(backend)
  render(<InvitationsPage />, { wrapper: harness.wrapper })
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

describe('InvitationsPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists pending invitations first, and switches by status', async () => {
    const harness = await renderPage()
    expect(screen.getByText('pending@example.com')).toBeInTheDocument()
    expect(harness.requests[0].search.get('status')).toBe('pending')

    fireEvent.click(screen.getByRole('radio', { name: 'Accepted' }))
    await flush()

    expect(screen.getByText('accepted@example.com')).toBeInTheDocument()
    expect(screen.queryByText('pending@example.com')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Revoke invitation to/ })).not.toBeInTheDocument()
  })

  it('revokes a pending invitation after a confirm', async () => {
    const harness = await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation to pending@example.com' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke invitation' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')?.path).toBe(
      'admin/invitations/inv-pending/revoke',
    )
  })

  it('invites an address, then shows the pending list', async () => {
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
    expect(screen.queryByText('Invitation sent to ada@corp.example.')).not.toBeInTheDocument()

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

    expect(within(screen.getByLabelText('override@corp.example')).getByText('IdP override')).toBeInTheDocument()
    invitations.pop()
  })
})
