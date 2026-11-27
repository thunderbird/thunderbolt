/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush } from '../../test-utils'
import { makeMember } from '../members/member-fixtures'
import type { FakeRequest } from '../../test-utils'
import { groupBackend, ops } from './group-fixtures'
import { GroupsPage } from './groups-page'

const openOps = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Open Ops' }))
  await flush()
}

const chooseMenuItem = async (name: string) => {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name }))
  await flush()
}

/** Open Ops, then its edit form from the view panel's menu. */
const editOps = async () => {
  await openOps()
  await chooseMenuItem('Edit')
}

const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
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

  it('narrows the groups by name, and says when nothing matches', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByPlaceholderText('Search groups'), { target: { value: 'op' } })
    expect(screen.getByRole('button', { name: 'Open Ops' })).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search groups'), { target: { value: 'zzz' } })
    expect(screen.queryByRole('button', { name: 'Open Ops' })).toBeNull()
    expect(screen.getByText('No matching groups.')).toBeInTheDocument()
  })

  it('shows an empty state that creates the first group', async () => {
    const respond = groupBackend()
    const harness = createAdminTestHarness((request) =>
      request.method === 'GET' && request.path === 'admin/groups'
        ? { body: { items: [], nextCursor: null } }
        : respond(request),
    )
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()

    expect(screen.getByText('No groups yet')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create your first group' }))
    await flush()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
  })

  it('opens a group read-only, with its members, and no admin subtitle for a plain group', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await openOps()

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ops' })).toBeInTheDocument()
    expect(screen.queryByText('Admin group')).toBeNull()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace from the group' })).not.toBeInTheDocument()
  })

  it('creates a group with its admin role, then shows it', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'New Group' }))
    await flush()
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Design' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Admin group' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await flush()

    expect(harness.requests.filter((request) => request.method === 'POST')).toMatchObject([
      { path: 'admin/groups', body: { name: 'Design', description: '' } },
      { path: 'admin/role-mappings', body: { localGroupId: 'g-new', role: 'admin' } },
    ])
    await flush()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Design' })).toBeInTheDocument()
  })

  it('renames a group from the edit form, then goes back to its view', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Operations' } })
    await save()

    expect(harness.requests.find((request) => request.method === 'PATCH')).toMatchObject({
      path: 'admin/groups/g1',
      body: { name: 'Operations' },
    })
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  })

  it('locks the form while a save is in flight', async () => {
    const respond = groupBackend()
    const reply = Promise.withResolvers<void>()
    const harness = createAdminTestHarness(async (request) => {
      if (request.method === 'PATCH') {
        await reply.promise
      }
      return respond(request)
    })
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Operations' } })
    await save()

    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Description')).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Admin group' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace from the group' })).toBeDisabled()
    reply.resolve()
    await flush()
  })

  it("opens the edit form from the row's context menu", async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Ops' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }))
    await flush()

    expect(screen.getByLabelText('Name')).toHaveValue('Ops')
  })

  it('goes back to the view on Cancel, without saving', async () => {
    const harness = createAdminTestHarness(groupBackend())
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await flush()

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(harness.requests.filter((request) => request.method !== 'GET')).toEqual([])
  })

  /** The groups backend, with `rename` standing in for another admin renaming Ops. */
  const sharedGroupBackend = () => {
    const respond = groupBackend()
    let served = ops
    return {
      rename: (name: string) => {
        served = { ...ops, name }
      },
      respond: (request: FakeRequest) =>
        request.method === 'GET' && request.path === 'admin/groups/g1' ? { body: served } : respond(request),
    }
  }

  it('keeps an unsaved edit, and shows another admin’s rename in the field it left alone', async () => {
    const backend = sharedGroupBackend()
    const harness = createAdminTestHarness(backend.respond)
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'On call this week' } })
    backend.rename('Platform')
    await harness.queryClient.invalidateQueries()
    await flush()

    expect(screen.getByLabelText('Description')).toHaveValue('On call this week')
    expect(screen.getByLabelText('Name')).toHaveValue('Platform')
  })

  it('saves only the field this admin edited, so another admin’s rename stands', async () => {
    const backend = sharedGroupBackend()
    const harness = createAdminTestHarness(backend.respond)
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'On call this week' } })
    backend.rename('Platform')
    await harness.queryClient.invalidateQueries()
    await flush()
    await save()

    expect(harness.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
      description: 'On call this week',
    })
  })

  it('shows another admin’s rename in the form when there is nothing unsaved', async () => {
    const backend = sharedGroupBackend()
    const harness = createAdminTestHarness(backend.respond)
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    backend.rename('Platform')
    await harness.queryClient.invalidateQueries()
    await flush()

    expect(screen.getByLabelText('Name')).toHaveValue('Platform')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('removes a member on Save, and shows the break-glass banner once no admin can sign in without the IdP', async () => {
    const respond = groupBackend({ body: { warning: 'NO_LOCAL_ADMIN' } })
    let removed = false
    const harness = createAdminTestHarness((request) => {
      if (request.method === 'DELETE') {
        removed = true
      }
      return request.path === 'admin/break-glass'
        ? { body: { allAdminsIdpManaged: removed, adminCount: 1, localAdminCount: removed ? 0 : 1 } }
        : respond(request)
    })
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace from the group' }))
    await flush()
    expect(harness.requests.filter((request) => request.method === 'DELETE')).toEqual([])
    await save()

    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe('admin/groups/g1/members/user-1')
    expect(screen.getByText('No admin can sign in without your identity provider')).toBeInTheDocument()
  })

  it('confirms before a save removes you from the group that is your only admin source', async () => {
    const self = makeMember({
      userId: 'admin-1',
      email: 'admin@example.com',
      name: 'Me',
      roles: [{ role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' }],
    })
    const respond = groupBackend({ body: {} }, self)
    const harness = createAdminTestHarness((request) =>
      request.method === 'GET' && request.path === 'admin/role-mappings'
        ? {
            body: {
              items: [
                {
                  id: 'm1',
                  role: 'admin',
                  target: { kind: 'local_group', groupId: 'g1', name: 'Ops' },
                  createdAt: '2026-11-01T00:00:00.000Z',
                },
              ],
            },
          }
        : respond(request),
    )
    render(<GroupsPage />, { wrapper: harness.wrapper })
    await flush()
    await editOps()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Me from the group' }))
    await save()
    expect(harness.requests.filter((request) => request.method === 'DELETE')).toEqual([])

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save and lose admin' }))
    await flush()
    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe(
      'admin/groups/g1/members/admin-1',
    )
  })

  it('saves at once when another source keeps you admin', async () => {
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
    await editOps()

    fireEvent.click(screen.getByRole('button', { name: 'Remove Me from the group' }))
    await save()

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

    await chooseMenuItem('Delete')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete group' }))
    await flush()

    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe('admin/groups/g1')
  })
})
