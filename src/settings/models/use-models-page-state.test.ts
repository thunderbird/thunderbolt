/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import * as modelsDal from '@/dal/models'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, spyOn } from 'bun:test'
import { useModelsPageState } from './use-models-page-state'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(resetTestDatabase)
afterEach(cleanup)

it.each(['resolve', 'reject'] as const)('keeps a newly selected model when an abandoned save %s', async (outcome) => {
  const pending = Promise.withResolvers<void>()
  const update = spyOn(modelsDal, 'updateModel').mockImplementation(() => pending.promise)
  try {
    const { result } = renderHook(() => useModelsPageState(), { wrapper: createTestProvider() })
    act(() => result.current.openEditPanel('old'))
    const values = { id: 'old', name: 'Old', model: 'model', url: '', apiKey: undefined, toolUsage: 1 as const }
    const first = result.current.submitEdit(values)
    await result.current.submitEdit(values)
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(update).toHaveBeenCalledTimes(1)
    act(() => result.current.openEditPanel('new'))
    await act(async () => {
      if (outcome === 'resolve') {
        pending.resolve()
      } else {
        pending.reject(new Error('old save failed'))
      }
      await first
      await getClock().runAllAsync()
    })
    expect(result.current.panel).toEqual({ kind: 'edit', modelId: 'new' })
    expect(result.current.mutationError).toBeNull()
  } finally {
    update.mockRestore()
  }
})
