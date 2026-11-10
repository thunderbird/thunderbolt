/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { afterAll, afterEach, beforeAll, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import * as providerConnections from '@/dal/provider-connections'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  getProviderConnections,
  getProviderCredentials,
  disconnectProviderConnection,
} from '@/dal/provider-connections'
import { createTestProvider } from '@/test-utils/test-provider'
import { searchSelectionStorageKey, useSearchProviderStore } from '@/stores/search-provider-store'
import { SearchProviderSetup } from './search-provider-setup'
import { useSearchProviderSetup } from './use-search-provider-setup'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(async () => {
  cleanup()
  mock.restore()
  useSearchProviderStore.getState().clearSearchProvider()
  await resetTestDatabase()
})
it('asks for a provider before displaying a key input', () => {
  render(<SearchProviderSetup />, { wrapper: createTestProvider() })
  expect(screen.getByRole('combobox', { name: 'Search provider' })).toBeTruthy()
  expect(screen.queryByLabelText('API key')).toBeNull()
})
it.each(['exa', 'brave', 'tavily'] as const)(
  'saves verified %s as a reusable connection without persisting its key in localStorage',
  async (provider) => {
    const test = mock(async () => {})
    const ready = mock(() => {})
    const saved = mock(() => {})
    const { result } = renderHook(() => useSearchProviderSetup(ready, saved, test), { wrapper: createTestProvider() })
    act(() => result.current.change({ provider, apiKey: '  secret-key  ' }))
    expect(await getProviderConnections(getDb())).toHaveLength(0)
    await act(async () => result.current.test())
    expect(test).toHaveBeenCalledWith(provider, 'secret-key', expect.any(AbortSignal))
    const [connection] = await getProviderConnections(getDb())
    expect(connection).toMatchObject({ provider, authMethod: 'api_key', connected: true })
    expect((await getProviderCredentials(getDb(), connection.id))?.apiKey).toBe('secret-key')
    expect(localStorage.getItem(searchSelectionStorageKey)).not.toContain('secret-key')
    expect(useSearchProviderStore.getState().connectionId).toBe(connection.id)
    expect(result.current.apiKey).toBe('')
    expect(ready).toHaveBeenLastCalledWith(true)
    expect(saved).toHaveBeenCalledTimes(1)
    act(() => result.current.change({ apiKey: 'replacement' }))
    await act(async () => result.current.test())
    expect(await getProviderConnections(getDb())).toHaveLength(1)
    expect((await getProviderCredentials(getDb(), connection.id))?.apiKey).toBe('replacement')
    await act(async () => result.current.disconnect())
    expect(await getProviderCredentials(getDb(), connection.id)).toBeNull()
    expect(useSearchProviderStore.getState().selection).toBe('none')
  },
)
it('keeps failures retryable without exposing provider error details', async () => {
  const { result } = renderHook(
    () =>
      useSearchProviderSetup(undefined, undefined, async () => {
        throw new Error('secret-key')
      }),
    { wrapper: createTestProvider() },
  )
  act(() => result.current.change({ provider: 'exa', apiKey: 'secret-key' }))
  await act(async () => result.current.test())
  expect(result.current.status).toBe('error')
  expect(result.current.error).not.toContain('secret-key')
  expect(await getProviderConnections(getDb())).toHaveLength(0)
})
it.each(['unmount', 'provider', 'selection'] as const)(
  'does not save a stale successful test after %s',
  async (change) => {
    const pending = Promise.withResolvers<void>()
    const { result, unmount } = renderHook(() => useSearchProviderSetup(undefined, undefined, () => pending.promise), {
      wrapper: createTestProvider(),
    })
    act(() => result.current.change({ provider: 'exa', apiKey: 'key' }))
    let running!: Promise<void>
    act(() => {
      running = result.current.test()
    })
    if (change === 'unmount') {
      unmount()
    }
    if (change === 'provider') {
      act(() => result.current.change({ provider: 'brave', apiKey: '' }))
    }
    if (change === 'selection') {
      act(() => useSearchProviderStore.getState().selectSearchProvider('none'))
    }
    await act(async () => {
      pending.resolve()
      await running
    })
    expect(await getProviderConnections(getDb())).toHaveLength(0)
  },
)

it('does not restore an existing connection disconnected during key verification', async () => {
  const test = mock(async () => {})
  const { result } = renderHook(() => useSearchProviderSetup(undefined, undefined, test), {
    wrapper: createTestProvider(),
  })
  act(() => result.current.change({ provider: 'exa', apiKey: 'original' }))
  await act(async () => result.current.test())
  const id = result.current.connectionId!
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<void>()
  test.mockImplementation(() => {
    started.resolve()
    return pending.promise
  })
  act(() => result.current.change({ apiKey: 'replacement' }))
  let running!: Promise<void>
  act(() => {
    running = result.current.test()
  })
  await started.promise
  await disconnectProviderConnection(getDb(), id)
  await act(async () => {
    pending.resolve()
    await running
  })
  expect(await getProviderCredentials(getDb(), id)).toBeNull()
  expect(result.current.status).toBe('error')
  expect(useSearchProviderStore.getState().connectionId).toBe(id)
})

it.each(['unmount', 'provider', 'selection'] as const)(
  'does not finish stale onboarding after %s while saved connections refresh',
  async (change) => {
    const ready = mock(() => {})
    const saved = mock(() => {})
    const { result, unmount } = renderHook(
      () => ({ setup: useSearchProviderSetup(ready, saved, async () => {}), queryClient: useQueryClient() }),
      { wrapper: createTestProvider() },
    )
    const refreshing = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    spyOn(result.current.queryClient, 'invalidateQueries').mockImplementation(() => {
      refreshing.resolve()
      return pending.promise
    })
    act(() => result.current.setup.change({ provider: 'exa', apiKey: 'key' }))
    let running!: Promise<void>
    await act(async () => {
      running = result.current.setup.test()
      await refreshing.promise
    })
    if (change === 'unmount') {
      unmount()
    } else if (change === 'provider') {
      act(() => result.current.setup.change({ provider: 'brave', apiKey: '' }))
    } else {
      act(() => useSearchProviderStore.getState().selectSearchProvider('none'))
    }
    await act(async () => {
      pending.resolve()
      await running
    })
    expect(ready).not.toHaveBeenCalledWith(true)
    expect(saved).not.toHaveBeenCalled()
  },
)

it('preserves a newer search selection while disconnecting the old connection', async () => {
  const { result } = renderHook(() => useSearchProviderSetup(undefined, undefined, async () => {}), {
    wrapper: createTestProvider(),
  })
  act(() => result.current.change({ provider: 'exa', apiKey: 'key' }))
  await act(async () => result.current.test())
  const originalId = result.current.connectionId!
  await act(async () => {
    const disconnecting = result.current.disconnect()
    useSearchProviderStore.getState().selectSearchConnection('another-connection')
    await disconnecting
  })
  expect(await getProviderCredentials(getDb(), originalId)).toBeNull()
  expect(useSearchProviderStore.getState()).toMatchObject({
    selection: 'connection',
    connectionId: 'another-connection',
  })
})

it.each(['verification', 'refresh'] as const)(
  'completes setup when only cached capabilities change during %s',
  async (stage) => {
    const started = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<void>()
    const ready = mock(() => {})
    const saved = mock(() => {})
    const { result } = renderHook(
      () => ({
        setup: useSearchProviderSetup(ready, saved, async () => {
          if (stage === 'verification') {
            started.resolve()
            await pending.promise
          }
        }),
        queryClient: useQueryClient(),
      }),
      { wrapper: createTestProvider() },
    )
    if (stage === 'refresh') {
      spyOn(result.current.queryClient, 'invalidateQueries').mockImplementation(() => {
        started.resolve()
        return pending.promise
      })
    }
    act(() => result.current.setup.change({ provider: 'exa', apiKey: 'key' }))
    let running!: Promise<void>
    await act(async () => {
      running = result.current.setup.test()
      await started.promise
    })
    await act(async () => {
      useSearchProviderStore.getState().configureProviderSearch('another-account', 'available', { select: false })
      pending.resolve()
      await running
    })
    expect(result.current.setup.status).toBe('success')
    expect(ready).toHaveBeenLastCalledWith(true)
    expect(saved).toHaveBeenCalledTimes(1)
  },
)

it('does not clear a newer form or abort its verification when an older disconnect finishes', async () => {
  const verify = mock(async (_provider: string, _key: string, _signal: AbortSignal) => {})
  const { result } = renderHook(() => useSearchProviderSetup(undefined, undefined, verify), {
    wrapper: createTestProvider(),
  })
  act(() => result.current.change({ provider: 'exa', apiKey: 'original' }))
  await act(async () => result.current.test())
  const startedDisconnect = Promise.withResolvers<void>()
  const finishDisconnect = Promise.withResolvers<void>()
  const originalDisconnect = providerConnections.disconnectProviderConnection
  spyOn(providerConnections, 'disconnectProviderConnection').mockImplementation(async (db, id) => {
    await originalDisconnect(db, id)
    startedDisconnect.resolve()
    await finishDisconnect.promise
  })
  let disconnecting!: Promise<void>
  await act(async () => {
    disconnecting = result.current.disconnect()
    await startedDisconnect.promise
  })
  const finishVerification = Promise.withResolvers<void>()
  verify.mockImplementation(() => finishVerification.promise)
  act(() => result.current.change({ provider: 'brave', apiKey: 'new-key' }))
  let connecting!: Promise<void>
  act(() => {
    connecting = result.current.test()
  })
  await act(async () => {
    finishDisconnect.resolve()
    await disconnecting
  })
  expect(verify.mock.calls[1][2].aborted).toBe(false)
  expect(result.current).toMatchObject({ provider: 'brave', apiKey: 'new-key', status: 'testing' })
  await act(async () => {
    finishVerification.resolve()
    await connecting
  })
  expect(result.current.status).toBe('success')
  expect(useSearchProviderStore.getState().connectionId).toBe(result.current.connectionId)
})

it('keeps a failed disconnect retryable without exposing credential details', async () => {
  const { result } = renderHook(() => useSearchProviderSetup(undefined, undefined, async () => {}), {
    wrapper: createTestProvider(),
  })
  act(() => result.current.change({ provider: 'exa', apiKey: 'key' }))
  await act(async () => result.current.test())
  const id = result.current.connectionId!
  spyOn(providerConnections, 'disconnectProviderConnection').mockRejectedValue(new Error('secret-database-detail'))
  await act(async () => result.current.disconnect())
  expect(result.current.status).toBe('error')
  expect(result.current.error).toBe('Could not disconnect this search provider. Please try again.')
  expect(result.current.hasSavedKey).toBe(true)
  expect((await getProviderCredentials(getDb(), id))?.apiKey).toBe('key')
})
