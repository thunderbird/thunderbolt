/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderHook } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { adminQueryKeys } from '../../api/query-keys'
import { cursorListKey } from '../../api/use-cursor-list'
import { createAdminTestHarness } from '../../test-utils'
import { groupBackend, ops } from './group-fixtures'
import { useGroupPanelState } from './use-group-panel-state'

describe('useGroupPanelState', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it("opens on the group from the page's list, ignoring a plain page cached under the same key", () => {
    const harness = createAdminTestHarness(groupBackend())
    // The member form's picker reads the groups with a plain `useQuery` under the list key.
    harness.queryClient.setQueryData(adminQueryKeys.groups.list(), { items: [ops], nextCursor: null })
    harness.queryClient.setQueryData(cursorListKey(adminQueryKeys.groups.list()), {
      pages: [{ items: [ops], nextCursor: null }],
      pageParams: [undefined],
    })

    const { result } = renderHook(() => useGroupPanelState('g1'), { wrapper: harness.wrapper })

    expect(result.current.group.data).toEqual(ops)
  })
})
