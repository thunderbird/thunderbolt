/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { useServerConnectionState } from './use-server-connection-state'
import { ServerVersionUnsupportedError } from '@/lib/server-connection'

describe('useServerConnectionState', () => {
  it('explains an incompatible server while preserving local access', async () => {
    const connect = mock(async () => {
      throw new ServerVersionUnsupportedError()
    })
    const { result } = renderHook(() => useServerConnectionState(undefined, connect))
    await act(async () => result.current.submit())
    expect(result.current.error).toContain('Update Thunderbolt')
    expect(result.current.error).toContain('local models')
  })
  it('advances only after the server connection succeeds', async () => {
    const connected = mock()
    const connect = mock(async (_url: string) => {})
    const { result } = renderHook(() => useServerConnectionState(connected, connect))
    act(() => result.current.setServerUrl('https://my-server.example'))

    await act(async () => result.current.submit())

    expect(connect).toHaveBeenCalledWith('https://my-server.example', undefined, expect.any(AbortSignal))
    expect(connected).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
    expect(result.current.isConnecting).toBe(false)
  })

  it('keeps the entered address and permits retry after a failed connection', async () => {
    const connected = mock()
    const connect = mock(async (_url: string) => {
      throw new Error('Network unavailable')
    })
    const { result } = renderHook(() => useServerConnectionState(connected, connect))
    act(() => result.current.setServerUrl('https://my-server.example'))

    await act(async () => result.current.submit())

    expect(connected).not.toHaveBeenCalled()
    expect(result.current.serverUrl).toBe('https://my-server.example')
    expect(result.current.error).toContain("Couldn't connect")
    expect(result.current.isConnecting).toBe(false)
  })
  it('aborts validation when the form unmounts and ignores a late response', async () => {
    const pending = Promise.withResolvers<void>()
    const connect = mock((_url: string, _client?: unknown, _signal?: AbortSignal) => pending.promise)
    const connected = mock()
    const { result, unmount } = renderHook(() => useServerConnectionState(connected, connect))
    act(() => result.current.submit())
    const signal = connect.mock.calls[0][2]
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve())
    expect(connected).not.toHaveBeenCalled()
  })

  it('only the latest submission can advance or display an error', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const connect = mock((_url: string, _client?: unknown, _signal?: AbortSignal) => first.promise)
    const connected = mock()
    const { result } = renderHook(() => useServerConnectionState(connected, connect))
    act(() => result.current.submit())
    connect.mockImplementation(() => second.promise)
    act(() => result.current.submit())
    expect(connect.mock.calls[0][2]?.aborted).toBe(true)
    await act(async () => second.resolve())
    await act(async () => first.reject(new Error('stale failure')))
    expect(connected).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })
})
