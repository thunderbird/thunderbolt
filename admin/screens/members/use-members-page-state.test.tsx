/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { act, renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createAdminTestHarness, flush, type FakeRequest } from '../../test-utils'
import { makeMember } from './member-fixtures'
import { useMembersPageState } from './use-members-page-state'

const ada = makeMember()
const bob = makeMember({ userId: 'user-2', email: 'bob@example.com', name: 'Bob' })

/** Two pages of members, or the one that matches `q`. */
const backend = ({ method, path, search }: FakeRequest) => {
  if (method === 'DELETE') {
    return { status: 204 }
  }
  if (path !== 'admin/members') {
    return { status: 404, body: { code: 'MEMBER_NOT_FOUND' } }
  }
  if (search.get('q')) {
    return { body: { items: [bob], nextCursor: null } }
  }
  return search.get('cursor')
    ? { body: { items: [bob], nextCursor: null } }
    : { body: { items: [ada], nextCursor: 'ada@example.com' } }
}

describe('useMembersPageState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('lists members 100 at a time and loads more by cursor', async () => {
    const harness = createAdminTestHarness(backend)
    const { result } = renderHook(useMembersPageState, { wrapper: harness.wrapper })
    await flush()

    expect(result.current.list.items.map((member) => member.userId)).toEqual(['user-1'])
    expect(harness.requests[0].search.get('limit')).toBe('100')
    act(() => result.current.list.loadMore())
    await flush()

    expect(result.current.list.items.map((member) => member.userId)).toEqual(['user-1', 'user-2'])
    const cursors = harness.requests
      .filter((request) => request.path === 'admin/members')
      .map((r) => r.search.get('cursor'))
    expect(cursors).toEqual([null, 'ada@example.com'])
  })

  it('searches on the server, trimming the query', async () => {
    const harness = createAdminTestHarness(backend)
    const { result } = renderHook(useMembersPageState, { wrapper: harness.wrapper })
    await flush()

    act(() => result.current.setSearch('  bob '))
    await flush()

    expect(harness.requests.at(-1)?.search.get('q')).toBe('bob')
    expect(result.current.list.items.map((member) => member.userId)).toEqual(['user-2'])
  })

  it('purges a member and refetches the list', async () => {
    const harness = createAdminTestHarness(backend)
    const { result } = renderHook(useMembersPageState, { wrapper: harness.wrapper })
    await flush()

    await act(() => result.current.purge('user-1'))
    await flush()

    expect(harness.requests.find((request) => request.method === 'DELETE')?.path).toBe('admin/members/user-1')
    expect(harness.requests.filter((request) => request.path === 'admin/members')).toHaveLength(2)
  })
})
