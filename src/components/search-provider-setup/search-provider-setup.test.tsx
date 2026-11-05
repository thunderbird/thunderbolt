/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useSearchProviderStore } from '@/stores/search-provider-store'
import { SearchProviderSetup } from './search-provider-setup'
import { useSearchProviderSetup } from './use-search-provider-setup'

afterEach(() => {
  cleanup()
  useSearchProviderStore.getState().clearSearchProvider()
})

describe('search provider setup', () => {
  it('asks for a provider before displaying the API key', () => {
    render(<SearchProviderSetup />)
    expect(screen.getByRole('combobox', { name: 'Search provider' })).toBeTruthy()
    expect(screen.queryByLabelText('API key')).toBeNull()
  })

  it.each(['exa', 'brave', 'tavily'] as const)('only saves %s after a successful test', async (provider) => {
    const test = mock(async () => {})
    const ready = mock(() => {})
    const saved = mock(() => {})
    const { result } = renderHook(() => useSearchProviderSetup(ready, saved, test))
    act(() => result.current.change({ provider, apiKey: '  key  ' }))
    expect(useSearchProviderStore.getState().apiKey).toBe('')
    await act(async () => result.current.test())
    expect(test).toHaveBeenCalledWith(provider, 'key', expect.any(AbortSignal))
    expect(useSearchProviderStore.getState()).toMatchObject({ provider, apiKey: 'key' })
    expect(ready).toHaveBeenLastCalledWith(true)
    expect(saved).toHaveBeenCalledTimes(1)
    act(() => result.current.change({ apiKey: 'new-key' }))
    expect(ready).toHaveBeenLastCalledWith(false)
    expect(result.current.status).toBe('idle')
  })

  it('keeps failed tests retryable and hides upstream error details', async () => {
    const test = mock(async () => {
      throw new Error('secret-key')
    })
    const { result } = renderHook(() => useSearchProviderSetup(undefined, undefined, test))
    act(() => result.current.change({ provider: 'exa', apiKey: 'bad-key' }))
    await act(async () => result.current.test())
    expect(result.current.status).toBe('error')
    expect(result.current.error).not.toContain('secret-key')
    expect(useSearchProviderStore.getState().apiKey).toBe('')
  })

  it('ignores a successful result after the provider changes', async () => {
    const pending = Promise.withResolvers<void>()
    const { result } = renderHook(() => useSearchProviderSetup(undefined, undefined, () => pending.promise))
    act(() => result.current.change({ provider: 'exa', apiKey: 'old-key' }))
    let running!: Promise<void>
    act(() => {
      running = result.current.test()
    })
    act(() => result.current.change({ provider: 'brave', apiKey: '' }))
    await act(async () => {
      pending.resolve()
      await running
    })
    expect(result.current.provider).toBe('brave')
    expect(result.current.status).toBe('idle')
    expect(useSearchProviderStore.getState().apiKey).toBe('')
  })

  it('does not save after skipping away from a pending test', async () => {
    const pending = Promise.withResolvers<void>()
    const { result, unmount } = renderHook(() => useSearchProviderSetup(undefined, undefined, () => pending.promise))
    act(() => result.current.change({ provider: 'tavily', apiKey: 'key' }))
    let running!: Promise<void>
    act(() => {
      running = result.current.test()
    })
    unmount()
    await act(async () => {
      pending.resolve()
      await running
    })
    expect(useSearchProviderStore.getState().apiKey).toBe('')
  })

  it.each(['disconnectSearchProvider', 'clearSearchProvider'] as const)(
    'does not restore a key after %s supersedes its pending test',
    async (reset) => {
      const pending = Promise.withResolvers<void>()
      const saved = mock(() => {})
      const { result } = renderHook(() => useSearchProviderSetup(undefined, saved, () => pending.promise))
      act(() => result.current.change({ provider: 'exa', apiKey: 'old-key' }))
      let running!: Promise<void>
      act(() => {
        running = result.current.test()
      })
      act(() => useSearchProviderStore.getState()[reset]())
      await act(async () => {
        pending.resolve()
        await running
      })
      expect(useSearchProviderStore.getState().apiKey).toBe('')
      expect(result.current.status).toBe('idle')
      expect(saved).not.toHaveBeenCalled()
    },
  )

  it('disconnects saved credentials', () => {
    useSearchProviderStore.getState().configureSearchProvider('existing-key')
    render(<SearchProviderSetup />)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(useSearchProviderStore.getState().provider).toBeNull()
    expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(true)
  })

  it.each(['disconnect', 'replace key', 'replace provider'] as const)(
    'stops showing Connected when another window changes the saved connection: %s',
    (change) => {
      useSearchProviderStore.getState().configureSearchProvider('existing-key', 'exa')
      render(<SearchProviderSetup provider="exa" />)
      expect(screen.getByText('Connected')).toBeTruthy()
      act(() => {
        const stored = useSearchProviderStore.getState()
        if (change === 'disconnect') {
          stored.disconnectSearchProvider()
        } else {
          stored.configureSearchProvider('replacement-key', change === 'replace provider' ? 'brave' : 'exa')
        }
      })
      expect(screen.queryByText('Connected')).toBeNull()
      expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(false)
      expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('existing-key')
    },
  )
})

it.each(['custom', 'none', 'tinfoil', 'cloud'] as const)(
  'disconnecting a saved key preserves %s search intent without falling back',
  (selection) => {
    useSearchProviderStore.getState().configureSearchProvider('key', 'exa')
    useSearchProviderStore.getState().selectSearchProvider(selection)
    const { result } = renderHook(() => useSearchProviderSetup())
    act(() => result.current.disconnect())
    expect(useSearchProviderStore.getState().apiKey).toBe('')
    expect(useSearchProviderStore.getState().selection).toBe(selection === 'custom' ? 'none' : selection)
  },
)

it('explains Brave search-only capability when configuring its key', () => {
  const { rerender } = render(<SearchProviderSetup provider="brave" />)
  expect(
    screen.getByText('Brave provides search results. Choose Exa, Tavily, or Tinfoil to read full pages.'),
  ).toBeTruthy()
  rerender(<SearchProviderSetup key="exa" provider="exa" />)
  expect(
    screen.queryByText('Brave provides search results. Choose Exa, Tavily, or Tinfoil to read full pages.'),
  ).toBeNull()
})
