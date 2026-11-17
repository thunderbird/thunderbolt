/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush } from '../../test-utils'
import { makeMember } from '../members/member-fixtures'
import { groupBackend } from './group-fixtures'
import { GroupsPage } from './groups-page'

const openOps = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Ops' }))
  await flush()
}

describe('GroupsPage', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('lists groups with their member count', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()

    expect(screen.getByText('1 member')).toBeInTheDocument()
  })

  it('creates a group, then shows its role and members', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()

    fireEvent.click(screen.getAllByRole('button', { name: 'New group' })[0])
    await flush()
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Design' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'POST')).toMatchObject({
      path: 'admin/groups',
      body: { name: 'Design', description: '' },
    })
    // The new group's panel mounts, then loads the group.
    await flush()
    expect(screen.getByRole('switch', { name: 'Make members of Design admins' })).toBeInTheDocument()
  })

  it('renames a group', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await openOps()

    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Operations' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'PATCH')).toMatchObject({
      path: 'admin/groups/g1',
      body: { name: 'Operations' },
    })
  })

  it('removes a member and shows the break-glass warning it returns', async () => {
    const harness = createAdminTestHarness(groupBackend({ body: { warning: 'NO_LOCAL_ADMIN' } }))
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await openOps()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace from the group' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe('admin/groups/g1/members/user-1')
    expect(screen.getByText('No admin can sign in without your identity provider')).toBeInTheDocument()
  })

  it('confirms before you remove yourself from the group that is your only admin source', async () => {
    const self = makeMember({
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Me',
      roles: [{ role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' }],
    })
    const harness = createAdminTestHarness(groupBackend({ body: {} }, self))
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await openOps()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Me from the group' }))
    await flush()
    expect(harness.requests.filter((request) => request.method === 'DELETE')).toEqual([])

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove me from the group' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe(
      'admin/groups/g1/members/admin-1',
    )
  })

  it('removes you at once when another source keeps you admin', async () => {
    const self = makeMember({
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Me',
      roles: [
        { role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' },
        { role: 'admin', from: 'bootstrap' },
      ],
    })
    const harness = createAdminTestHarness(groupBackend({ body: {} }, self))
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await openOps()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Me from the group' }))
    await flush()

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe(
      'admin/groups/g1/members/admin-1',
    )
  })

  it('deletes a group after a confirm', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await openOps()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete group' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete group' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe('admin/groups/g1')
  })
})
