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
import type { ResourcePageState } from '../../components/use-resource-page-state'
import { memberActions } from './member-actions'
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
    if (path === 'admin/groups') {
      return { body: { items: [{ id: 'g2', name: 'Design' }], nextCursor: null } }
    }
    if (method === 'POST' && path.startsWith('admin/groups/')) {
      return { status: 204 }
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

const renderPanel = (
  harness: ReturnType<typeof createAdminTestHarness>,
  { userId = 'user-1', isEditing = false }: { userId?: string; isEditing?: boolean } = {},
) => {
  const handlers = { edit: mock(), patch: mock(), onBlock: mock(), onUnblock: mock(), onSaved: mock() }
  // The page's actions, wired to mocks: the panel's ⋯ menu offers exactly these.
  const page = { edit: handlers.edit, patch: handlers.patch } as unknown as ResourcePageState
  render(
    <MemberPanel
      userId={userId}
      isEditing={isEditing}
      actions={(member) =>
        memberActions(member, {
          page,
          selfId: 'admin-1',
          connectionStatusById: new Map([[okta.id, 'active']]),
          onBlock: handlers.onBlock,
          onUnblock: handlers.onUnblock,
        })
      }
      onCancelEdit={() => {}}
      onSaved={handlers.onSaved}
      onClose={() => {}}
      onDirtyChange={() => {}}
    />,
    { wrapper: harness.wrapper },
  )
  return handlers
}

const openMenu = async () => {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false })
  await screen.findByRole('menu')
}

const chooseMenuItem = async (name: string) => {
  await openMenu()
  fireEvent.click(screen.getByRole('menuitem', { name }))
  await flush()
}

const changes = (harness: ReturnType<typeof createAdminTestHarness>) =>
  harness.requests.filter((request) => request.method !== 'GET')

const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await flush()
}

describe('MemberPanel', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  /** A local member's backend where `rename` stands in for another admin renaming them. */
  const sharedMemberBackend = () => {
    const respond = backend(makeMember())
    let served = makeMember()
    return {
      rename: (name: string) => {
        served = makeMember({ name })
      },
      respond: (request: FakeRequest) =>
        request.method === 'GET' && request.path === 'admin/members/user-1' ? { body: served } : respond(request),
    }
  }

  describe('view', () => {
    it('is read-only, and opens the edit form from its menu', async () => {
      const harness = createAdminTestHarness(backend(makeMember()))
      const { edit } = renderPanel(harness)
      await flush()

      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
      await chooseMenuItem('Edit')
      expect(edit).toHaveBeenCalledWith('user-1')
    })

    it('labels what the IdP manages', async () => {
      const harness = createAdminTestHarness(backend(makeScimMember('active', { requiresSso: true })))
      renderPanel(harness)
      await flush()

      expect(screen.getByText(/Managed by Okta/)).toBeInTheDocument()
      expect(screen.getByText(/SSO only/)).toBeInTheDocument()
    })

    it('offers Block from its menu', async () => {
      const harness = createAdminTestHarness(backend(makeMember()))
      const { onBlock } = renderPanel(harness)
      await flush()

      await chooseMenuItem('Block')
      expect(onBlock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }))
    })

    it("doesn't offer to block yourself", async () => {
      const harness = createAdminTestHarness(backend(makeMember({ userId: 'admin-1' })))
      renderPanel(harness, { userId: 'admin-1' })
      await flush()

      await openMenu()
      expect(screen.queryByRole('menuitem', { name: 'Block' })).not.toBeInTheDocument()
    })

    it('shows the block reason, and offers Unblock instead', async () => {
      const blocked = makeMember({
        access: { allowed: false, reason: 'blocked' },
        blocked: { at: '2026-11-02T00:00:00.000Z', by: 'admin-1', reason: 'Lost laptop' },
      })
      const harness = createAdminTestHarness(backend(blocked))
      const { onUnblock } = renderPanel(harness)
      await flush()

      expect(screen.getByText('Blocked by an admin')).toBeInTheDocument()
      expect(screen.getByText(/Lost laptop/)).toBeInTheDocument()
      await chooseMenuItem('Unblock')
      expect(onUnblock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }))
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

      expect(screen.getByRole('link', { name: 'Ops' })).toHaveAttribute('href', '/admin/groups')
      expect(screen.getByText('From Admins in Okta')).toBeInTheDocument()
    })

    it("gives a local admin's email-code sign-in address for when the identity provider is down", async () => {
      const harness = createAdminTestHarness(backend(makeMember({ roles: [{ role: 'admin', from: 'local' }] })))
      renderPanel(harness)
      await flush()

      expect(screen.getByText('Can sign in without your identity provider')).toBeInTheDocument()
      expect(screen.getByLabelText('Email-code sign-in address')).toHaveValue(`${window.location.origin}/`)
    })

    it('gives a SCIM-only admin the email-code address too, since no identity provider requires SSO of them', async () => {
      const harness = createAdminTestHarness(
        backend(makeScimMember('active', { roles: [{ role: 'admin', from: 'local' }] })),
      )
      renderPanel(harness)
      await flush()

      expect(screen.getByText('Can sign in without your identity provider')).toBeInTheDocument()
      expect(screen.getByLabelText('Email-code sign-in address')).toHaveValue(`${window.location.origin}/`)
    })

    it('says an admin the identity provider requires SSO of depends on it to sign in', async () => {
      const member = makeScimMember('active', { roles: [{ role: 'admin', from: 'local' }], requiresSso: true })
      const harness = createAdminTestHarness(backend(member))
      renderPanel(harness)
      await flush()

      expect(screen.getByText('Signs in only through Okta')).toBeInTheDocument()
      expect(screen.queryByLabelText('Email-code sign-in address')).not.toBeInTheDocument()
    })

    it('says nothing about signing in without the identity provider for a member who is not an admin', async () => {
      const harness = createAdminTestHarness(backend(makeMember()))
      renderPanel(harness)
      await flush()

      expect(screen.queryByText(/sign in without your identity provider/)).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Email-code sign-in address')).not.toBeInTheDocument()
    })

    it('detaches a link the IdP deleted, after a confirm', async () => {
      const harness = createAdminTestHarness(backend(makeScimMember('removed')))
      renderPanel(harness)
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Detach from Okta' }))
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Detach' }))
      await flush()

      expect(changes(harness)).toMatchObject([
        { method: 'POST', path: 'admin/members/user-1/connections/conn-1/detach' },
      ])
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

      expect(screen.getByRole('link', { name: 'Design' })).toHaveAttribute('href', '/admin/groups')
    })

    it('offers permanent deletion only without access, and not while the IdP has only suspended them', async () => {
      renderPanel(createAdminTestHarness(backend(makeMember())))
      await flush()
      await openMenu()
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
      cleanup()

      const suspended = makeScimMember('suspended', { access: { allowed: false, reason: 'deprovisioned' } })
      renderPanel(createAdminTestHarness(backend(suspended)))
      await flush()
      expect(
        screen.getByText('The identity provider can reactivate them. Delete the user there first.'),
      ).toBeInTheDocument()
      await openMenu()
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true')
      cleanup()

      const removed = makeScimMember('removed', { access: { allowed: false, reason: 'deprovisioned' } })
      const { patch } = renderPanel(createAdminTestHarness(backend(removed)))
      await flush()
      expect(screen.getByText('Removed by the identity provider')).toBeInTheDocument()
      await chooseMenuItem('Delete')
      expect(patch).toHaveBeenCalledWith({ removeId: 'user-1' })
    })
  })

  describe('edit form', () => {
    it('renames a local member, then hands back to the view', async () => {
      const harness = createAdminTestHarness(backend(makeMember()))
      const { onSaved } = renderPanel(harness, { isEditing: true })
      await flush()

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
      await save()

      expect(changes(harness)).toMatchObject([
        { method: 'PATCH', path: 'admin/members/user-1', body: { name: 'Ada King' } },
      ])
      expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('saves a change for a member with no name', async () => {
      const harness = createAdminTestHarness(backend(makeMember({ name: '' })))
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('switch', { name: 'Admin' }))
      await save()

      expect(changes(harness)).toMatchObject([{ method: 'POST', path: 'admin/members/user-1/roles' }])
    })

    it('keeps the name read-only when the IdP manages it', async () => {
      const harness = createAdminTestHarness(backend(makeScimMember('active')))
      renderPanel(harness, { isEditing: true })
      await flush()

      expect(screen.getByLabelText('Name')).toBeDisabled()
    })

    it('keeps an unsaved name edit when a refresh brings in another admin’s rename', async () => {
      const shared = sharedMemberBackend()
      const harness = createAdminTestHarness(shared.respond)
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
      shared.rename('Augusta Ada')
      await harness.queryClient.invalidateQueries()
      await flush()

      expect(screen.getByLabelText('Name')).toHaveValue('Ada King')
    })

    it('shows another admin’s rename when there is no unsaved name edit', async () => {
      const shared = sharedMemberBackend()
      const harness = createAdminTestHarness(shared.respond)
      renderPanel(harness, { isEditing: true })
      await flush()

      shared.rename('Augusta Ada')
      await harness.queryClient.invalidateQueries()
      await flush()

      expect(screen.getByLabelText('Name')).toHaveValue('Augusta Ada')
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })

    it('grants admin on Save', async () => {
      const harness = createAdminTestHarness(backend(makeMember()))
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('switch', { name: 'Admin' }))
      expect(changes(harness)).toEqual([])
      await save()

      expect(changes(harness)).toMatchObject([
        { method: 'POST', path: 'admin/members/user-1/roles', body: { role: 'admin' } },
      ])
    })

    it('revokes a local admin grant on Save', async () => {
      const harness = createAdminTestHarness(backend(makeMember({ roles: [{ role: 'admin', from: 'local' }] })))
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('switch', { name: 'Admin' }))
      await save()

      expect(changes(harness)).toMatchObject([{ method: 'DELETE', path: 'admin/members/user-1/roles/admin' }])
    })

    it('leaves the switch off when admin comes only from a group', async () => {
      const member = makeMember({ roles: [{ role: 'admin', from: 'local_group', groupId: 'g1', groupName: 'Ops' }] })
      const harness = createAdminTestHarness(backend(member))
      renderPanel(harness, { isEditing: true })
      await flush()

      expect(screen.getByRole('switch', { name: 'Admin' })).not.toBeChecked()
    })

    it('adds the member to a group on Save', async () => {
      const harness = createAdminTestHarness(backend(makeMember()))
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Choose groups' }))
      fireEvent.click(await screen.findByText('Design'))
      await save()

      expect(changes(harness)).toMatchObject([
        { method: 'POST', path: 'admin/groups/g2/members', body: { userId: 'user-1' } },
      ])
    })

    it('loads every page of groups into the picker', async () => {
      const respond = backend(makeMember())
      const harness = createAdminTestHarness((request) => {
        if (request.path !== 'admin/groups') {
          return respond(request)
        }
        return request.search.get('cursor') === 'c2'
          ? { body: { items: [{ id: 'g3', name: 'Sales' }], nextCursor: null } }
          : { body: { items: [{ id: 'g2', name: 'Design' }], nextCursor: 'c2' } }
      })
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Choose groups' }))
      expect(await screen.findByText('Design')).toBeInTheDocument()
      expect(screen.getByText('Sales')).toBeInTheDocument()
    })

    it('leaves alone a group another admin added while this admin edited the groups', async () => {
      const ops = { id: 'g1', name: 'Ops' }
      const respond = backend(makeMember({ groups: [ops] }))
      let served = makeMember({ groups: [ops] })
      const harness = createAdminTestHarness((request) =>
        request.method === 'GET' && request.path === 'admin/members/user-1' ? { body: served } : respond(request),
      )
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('button', { name: '1 selected' }))
      fireEvent.click(await screen.findByText('Design'))
      served = makeMember({ groups: [ops, { id: 'g3', name: 'Sales' }] })
      await harness.queryClient.invalidateQueries()
      await flush()
      await save()

      expect(changes(harness)).toMatchObject([{ method: 'POST', path: 'admin/groups/g2/members' }])
      expect(changes(harness)).toHaveLength(1)
    })

    it('joins groups before revoking the admin grant, so moving admin to a group never drops it midway', async () => {
      const harness = createAdminTestHarness(backend(makeMember({ roles: [{ role: 'admin', from: 'local' }] })))
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('switch', { name: 'Admin' }))
      fireEvent.click(screen.getByRole('button', { name: 'Choose groups' }))
      fireEvent.click(await screen.findByText('Design'))
      await save()

      expect(changes(harness)).toMatchObject([
        { method: 'POST', path: 'admin/groups/g2/members' },
        { method: 'DELETE', path: 'admin/members/user-1/roles/admin' },
      ])
    })

    it('locks the fields while saving', async () => {
      const respond = backend(makeMember())
      const held = Promise.withResolvers<void>()
      const harness = createAdminTestHarness(async (request) => {
        if (request.method === 'PATCH') {
          await held.promise
        }
        return respond(request)
      })
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
      await save()

      expect(screen.getByLabelText('Name')).toBeDisabled()
      expect(screen.getByRole('switch', { name: 'Admin' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Choose groups' })).toBeDisabled()
      held.resolve()
      await flush()
      expect(screen.getByLabelText('Name')).toBeEnabled()
    })

    it('confirms before a save takes away your own last admin role', async () => {
      const self = makeMember({ userId: 'admin-1', roles: [{ role: 'admin', from: 'bootstrap' }] })
      const harness = createAdminTestHarness(backend(self))
      renderPanel(harness, { userId: 'admin-1', isEditing: true })
      await flush()

      fireEvent.click(screen.getByRole('switch', { name: 'Admin' }))
      await save()
      expect(changes(harness)).toEqual([])

      fireEvent.click(screen.getByRole('button', { name: 'Save and lose admin' }))
      await flush()
      expect(changes(harness)).toMatchObject([{ method: 'DELETE', path: 'admin/members/admin-1/roles/admin' }])
    })

    it('shows a refused change in the form', async () => {
      const harness = createAdminTestHarness(
        backend(makeMember(), { status: 409, body: { code: 'FIELD_MANAGED_BY_IDP' } }),
      )
      renderPanel(harness, { isEditing: true })
      await flush()

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada King' } })
      await save()

      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })
})
