/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import * as tauriCore from '@tauri-apps/api/core'
import * as tauriEvent from '@tauri-apps/api/event'
import * as opener from '@tauri-apps/plugin-opener'
import { startSsoFlowLoopback } from './sso-loopback'

describe('startSsoFlowLoopback', () => {
  let unlistenFn: ReturnType<typeof mock>
  let listenSpy: ReturnType<typeof spyOn>
  let openUrlSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    unlistenFn = mock()

    spyOn(tauriCore, 'invoke').mockImplementation(async () => 17421 as never)
    listenSpy = spyOn(tauriEvent, 'listen').mockImplementation(async () => () => {})
    openUrlSpy = spyOn(opener, 'openUrl').mockImplementation(async () => {})
  })

  afterEach(() => {
    mock.restore()
  })

  it('returns bearer token on successful callback', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421/?token=rawtoken.sig123' } }))
      return unlistenFn
    })

    const result = await startSsoFlowLoopback('http://localhost:8000')

    expect(result).toBe('rawtoken.sig123')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('opens the desktop-initiate URL with the correct port', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421/?token=tok' } }))
      return unlistenFn
    })

    await startSsoFlowLoopback('http://localhost:8000')

    expect(openUrlSpy).toHaveBeenCalledWith(
      'http://localhost:8000/v1/api/auth/sso/desktop-initiate?loopback_port=17421',
    )
  })

  it('throws the error code, never the free-text description, when the callback carries an error', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() =>
        cb({ payload: { url: 'http://localhost:17421/?error=access_denied&error_description=User+denied' } }),
      )
      return unlistenFn
    })

    await expect(startSsoFlowLoopback('http://localhost:8000')).rejects.toMatchObject({
      code: 'access_denied',
      message: 'access_denied',
    })
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('throws when callback URL has no token', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421/' } }))
      return unlistenFn
    })

    await expect(startSsoFlowLoopback('http://localhost:8000')).rejects.toThrow('No token in SSO callback')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('ignores other loopback flows, remote origins, paths, and malformed callback events', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => {
        for (const url of [
          'http://localhost:17422/?error=unrelated-provider',
          'https://localhost:17421/?token=foreign-token',
          'https://evil.example/?token=foreign-token',
          'http://localhost:17421/unrelated?error=wrong-path',
          'not-a-url',
          'http://localhost:17421/?token=real-token',
        ]) {
          cb({ payload: { url } })
        }
      })
      return unlistenFn
    })
    const result = await startSsoFlowLoopback('http://localhost:8000')
    expect(result).toBe('real-token')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('returns null on timeout', async () => {
    listenSpy.mockImplementation(async () => unlistenFn)

    const clock = getClock()
    const promise = startSsoFlowLoopback('http://localhost:8000', 1)

    await clock.tickAsync(10)

    const result = await promise
    expect(result).toBeNull()
    const start = (tauriCore.invoke as ReturnType<typeof mock>).mock.calls.find(
      ([command]) => command === 'start_oauth_server',
    )
    expect(tauriCore.invoke).toHaveBeenCalledWith('stop_oauth_server', start?.[1])
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('cleans up listener on error', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421/?error=server_error' } }))
      return unlistenFn
    })

    await expect(startSsoFlowLoopback('http://localhost:8000')).rejects.toThrow('server_error')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('decodes URL-encoded token from callback', async () => {
    listenSpy.mockImplementation(async (_event: string, cb: (event: { payload: { url: string } }) => void) => {
      queueMicrotask(() => cb({ payload: { url: 'http://localhost:17421/?token=rawtoken.sig%3D%3D' } }))
      return unlistenFn
    })

    const result = await startSsoFlowLoopback('http://localhost:8000')
    // URL.searchParams.get() auto-decodes %3D to =
    expect(result).toBe('rawtoken.sig==')
  })
})
