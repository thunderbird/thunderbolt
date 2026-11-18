/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { createAdminTestHarness, flush } from '../../test-utils'
import { useMembersPageState } from '../members/use-members-page-state'
import { groupBackend } from './group-fixtures'
import { useGroupPanelState } from './use-group-panel-state'

describe('useGroupPanelState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('offers only members who are not in the group yet', async () => {
    const harness = createAdminTestHarness(groupBackend())
    const { result } = renderHook(() => useGroupPanelState('g1', () => {}), { wrapper: harness.wrapper })
    await flush()

    expect(result.current.members.items.map((member) => member.userId)).toEqual(['user-1'])
    expect(result.current.candidates.map((member) => member.userId)).toEqual(['user-2'])
  })

  it('searches for members to add on the server', async () => {
    const harness = createAdminTestHarness(groupBackend())
    const { result } = renderHook(() => useGroupPanelState('g1', () => {}), { wrapper: harness.wrapper })
    await flush()

    act(() => result.current.setSearch(' bob '))
    await flush()

    expect(harness.requests.at(-1)).toMatchObject({ path: 'admin/members' })
    expect(harness.requests.at(-1)?.search.get('q')).toBe('bob')
  })

  it("doesn't share a cache entry with the Members page for the same search", async () => {
    const harness = createAdminTestHarness(groupBackend())
    const { result } = renderHook(() => ({ panel: useGroupPanelState('g1', () => {}), page: useMembersPageState() }), {
      wrapper: harness.wrapper,
    })
    await flush()

    const entries = harness.queryClient
      .getQueryCache()
      .findAll({ queryKey: adminQueryKeys.members.list(undefined) })
      .map((query) => query.queryKey)
    expect(entries).toHaveLength(2)
    expect(result.current.page.list.items).toHaveLength(2)
    expect(result.current.panel.candidates).toHaveLength(1)
  })

  it('creates a group and hands over its id', async () => {
    const harness = createAdminTestHarness(groupBackend())
    const onCreated = mock()
    const { result } = renderHook(() => useGroupPanelState(null, onCreated), { wrapper: harness.wrapper })
    await flush()
    const adminRequests = () => harness.requests.filter((request) => request.path.startsWith('admin/'))
    expect(adminRequests()).toEqual([])

    act(() => result.current.save.mutate({ name: 'Design', description: '' }))
    await flush()

    expect(adminRequests()[0]).toMatchObject({ method: 'POST', path: 'admin/groups', body: { name: 'Design' } })
    expect(onCreated).toHaveBeenCalledWith('g-new')
  })

  it('adds and removes members at once, and keeps the break-glass warning of a removal', async () => {
    const harness = createAdminTestHarness(groupBackend({ body: { warning: 'NO_LOCAL_ADMIN' } }))
    const { result } = renderHook(() => useGroupPanelState('g1', () => {}), { wrapper: harness.wrapper })
    await flush()

    act(() => result.current.addMember.mutate('user-2'))
    await flush()
    act(() => result.current.removeMember.mutate('user-1'))
    await flush()

    const changes = harness.requests.filter((request) => request.method !== 'GET')
    expect(changes).toMatchObject([
      { method: 'POST', path: 'admin/groups/g1/members', body: { userId: 'user-2' } },
      { method: 'DELETE', path: 'admin/groups/g1/members/user-1' },
    ])
    expect(result.current.breakGlassWarning).toBe(true)
  })
})
