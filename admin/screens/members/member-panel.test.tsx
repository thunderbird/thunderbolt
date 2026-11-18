/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { AdminConnection, AdminMember } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply, type FakeRequest } from '../../test-utils'
import { makeMember, makeScimMember, okta } from './member-fixtures'
import { MemberPanel } from './member-panel'

const connection = (status: AdminConnection['status']): AdminConnection => ({
  id: okta.id,
  name: okta.name,
  status,
  matchClaim: 'email',
  sso: null,
  scim: { scimConnectionId: 'scim-1' },
  claimedDomains: [],
  createdAt: '2026-11-01T00:00:00.000Z',
})

/**
 * A backend holding `member`, answering every change with `changeReply` (the member by default). A
 * successful change's member is what later reads return.
 */
const backend = (member: AdminMember, changeReply?: FakeReply, connections = [connection('active')]) => {
  let current = member
  return ({ method, path }: FakeRequest): FakeReply => {
    if (path === 'admin/connections') {
      return { body: { items: connections } }
    }
    if (method === 'GET') {
      return { body: current }
    }
    const reply = changeReply ?? { body: current }
    if ((reply.status ?? 200) < 300) {
      const { warning: _warning, ...updated } = reply.body as AdminMember & { warning?: string }
      current = updated
    }
    return reply
  }
}

const renderPanel = (harness: ReturnType<typeof createAdminTestHarness>, userId = 'user-1') => {
  const onRequestPurge = mock()
  render(<MemberPanel userId={userId} onClose={() => {}} onDirtyChange={() => {}} onRequestPurge={onRequestPurge} />, {
    wrapper: harness.wrapper,
  })
  return { onRequestPurge }
}

const changes = (harness: ReturnType<typeof createAdminTestHarness>) =>
  harness.requests.filter((request) => request.method !== 'GET')

describe('MemberPanel', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('renames a local member', async () => {
    const harness = createAdminTestHarness(backend(makeMember()))
    renderPanel(harness)
    await flush()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await flush()

    expect(changes(harness)).toMatchObject([
      { method: 'PATCH', path: 'admin/members/user-1', body: { name: 'Ada King' } },
    ])
  })

  it('labels what the IdP manages and keeps the name read-only', async () => {
    const harness = createAdminTestHarness(backend(makeScimMember('active', { requiresSso: true })))
    renderPanel(harness)
    await flush()

    expect(screen.getByText('Managed by Okta')).toBeInTheDocument()
    expect(screen.getByText('Signs in with SSO only')).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly')
    expect(screen.getByText('Your identity provider manages this name. Change it there.')).toBeInTheDocument()
  })

  it('blocks with a reason, and shows the break-glass warning it returns', async () => {
    const harness = createAdminTestHarness(
      backend(makeMember(), { body: { ...makeMember(), warning: 'NO_LOCAL_ADMIN' } }),
    )
    renderPanel(harness)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Block' }))
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Left the company' } })
    fireEvent.click(screen.getByRole('button', { name: 'Block member' }))
    await flush()

    expect(changes(harness)).toMatchObject([
      { method: 'POST', path: 'admin/members/user-1/block', body: { reason: 'Left the company' } },
    ])
    expect(screen.getByText('No admin can sign in without your identity provider')).toBeInTheDocument()
  })

  it('disables blocking yourself and says why', async () => {
    const harness = createAdminTestHarness(backend(makeMember({ userId: 'admin-1' })))
    renderPanel(harness, 'admin-1')
    await flush()

    const block = screen.getByRole('button', { name: 'Block' })
    expect(block).toBeDisabled()
    expect(block).toHaveAccessibleDescription("You can't block yourself.")
  })

  it('unblocks a blocked member and shows the block reason', async () => {
    const blocked = makeMember({
      access: { allowed: false, reason: 'blocked' },
      blocked: { at: '2026-11-02T00:00:00.000Z', by: 'admin-1', reason: 'Lost laptop' },
    })
    const harness = createAdminTestHarness(backend(blocked, { body: makeMember() }))
    renderPanel(harness)
    await flush()

    expect(screen.getByText('Blocked by an admin')).toBeInTheDocument()
    expect(screen.getByText(/Lost laptop/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }))
    await flush()

    expect(changes(harness)).toMatchObject([{ method: 'POST', path: 'admin/members/user-1/unblock' }])
    expect(screen.getByText('Can sign in')).toBeInTheDocument()
  })

  it('labels each role by its origin, linking a local group', async () => {
    const member = makeScimMember('active', {
      roles: [
        { role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' },
        { role: 'admin', from: 'scim', groupId: 's1', groupName: 'Admins', connectionId: okta.id },
      ],
    })
    const harness = createAdminTestHarness(backend(member))
    renderPanel(harness)
    await flush()

    expect(screen.getByRole('link', { name: 'Ops' })).toHaveAttribute('href', '/admin/groups?edit=g1')
    expect(screen.getByText(/From the group Admins in Okta/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke admin' })).not.toBeInTheDocument()
    expect(screen.getByText('Admin comes from a group. Change the group to take it away.')).toBeInTheDocument()
  })

  it('grants and revokes a local admin grant', async () => {
    const harness = createAdminTestHarness(backend(makeMember({ roles: [{ role: 'admin', from: 'local' }] })))
    renderPanel(harness)
    await flush()

    expect(screen.getByText('Granted by an admin')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke admin' }))
    await flush()

    expect(changes(harness)).toMatchObject([{ method: 'DELETE', path: 'admin/members/user-1/roles/admin' }])
  })

  it('confirms before you revoke your own last admin role', async () => {
    const self = makeMember({ userId: 'admin-1', roles: [{ role: 'admin', from: 'bootstrap' }] })
    const harness = createAdminTestHarness(backend(self))
    renderPanel(harness, 'admin-1')
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Revoke admin' }))
    await flush()
    expect(changes(harness)).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Remove my admin role' }))
    await flush()
    expect(changes(harness)).toMatchObject([{ method: 'DELETE', path: 'admin/members/admin-1/roles/admin' }])
  })

  it('detaches a link the IdP deleted, after a confirm', async () => {
    const harness = createAdminTestHarness(backend(makeScimMember('removed')))
    renderPanel(harness)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Detach from Okta' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Detach' }))
    await flush()

    expect(changes(harness)).toMatchObject([{ method: 'POST', path: 'admin/members/user-1/connections/conn-1/detach' }])
  })

  it('disables detaching a link the IdP still vouches for', async () => {
    const harness = createAdminTestHarness(backend(makeScimMember('active')))
    renderPanel(harness)
    await flush()

    expect(screen.getByRole('button', { name: 'Detach from Okta' })).toHaveAccessibleDescription(
      'The identity provider still vouches for them. Remove them there first.',
    )
  })

  it('lists the groups the member is in, each linking to the group', async () => {
    const harness = createAdminTestHarness(backend(makeMember({ groups: [{ id: 'g2', name: 'Design' }] })))
    renderPanel(harness)
    await flush()

    expect(screen.getByRole('link', { name: 'Design' })).toHaveAttribute('href', '/admin/groups?edit=g2')
  })

  it('offers permanent deletion only without access, and not while the IdP has only suspended them', async () => {
    const withAccess = createAdminTestHarness(backend(makeMember()))
    renderPanel(withAccess)
    await flush()
    expect(screen.queryByRole('button', { name: 'Delete member' })).not.toBeInTheDocument()
    cleanup()

    const suspended = makeScimMember('suspended', { access: { allowed: false, reason: 'deprovisioned' } })
    renderPanel(createAdminTestHarness(backend(suspended)))
    await flush()
    expect(screen.getByRole('button', { name: 'Delete member' })).toBeDisabled()
    cleanup()

    const removed = makeScimMember('removed', { access: { allowed: false, reason: 'deprovisioned' } })
    const { onRequestPurge } = renderPanel(createAdminTestHarness(backend(removed)))
    await flush()
    expect(screen.getByText('Removed by the identity provider')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete member' }))
    expect(onRequestPurge).toHaveBeenCalledTimes(1)
  })

  it('shows a refused change where it was made', async () => {
    const harness = createAdminTestHarness(
      backend(makeMember(), { status: 409, body: { code: 'FIELD_MANAGED_BY_IDP' } }),
    )
    renderPanel(harness)
    await flush()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await flush()

    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
