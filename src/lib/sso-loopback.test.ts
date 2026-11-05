/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { installUrlCanParsePolyfill } from '@/polyfills'
import * as tauriCore from '@tauri-apps/api/core'
import * as tauriEvent from '@tauri-apps/api/event'
import * as opener from '@tauri-apps/plugin-opener'
import { startSsoFlowLoopback } from './sso-loopback'

describe('startSsoFlowLoopback', () => {
  let unlistenFn: ReturnType<typeof mock>
  let openUrlSpy: ReturnType<typeof spyOn<typeof opener, 'openUrl'>>
  let callback: (event: { payload: { url: string } }) => void

  beforeEach(() => {
    unlistenFn = mock()
    spyOn(tauriCore, 'invoke').mockImplementation(async () => 17421 as never)
    spyOn(tauriEvent, 'listen').mockImplementation(async (_event, handler) => {
      callback = handler as typeof callback
      return unlistenFn
    })
    openUrlSpy = spyOn(opener, 'openUrl').mockImplementation(async () => {})
  })

  afterEach(() => mock.restore())

  const respond = (initiate: string | URL, values: Record<string, string>) => {
    const state = new URL(initiate).searchParams.get('client_state')!
    callback({ payload: { url: `http://localhost:17421/?${new URLSearchParams({ client_state: state, ...values })}` } })
  }

  it('generates an unguessable client nonce and requires it with the bearer token', async () => {
    openUrlSpy.mockImplementation(async (url) => respond(url, { token: 'rawtoken.sig==' }))
    expect(await startSsoFlowLoopback('http://localhost:8000')).toBe('rawtoken.sig==')
    const initiate = new URL(openUrlSpy.mock.calls[0][0])
    expect(initiate.origin).toBe('http://localhost:8000')
    expect(initiate.pathname).toBe('/v1/api/auth/sso/desktop-initiate')
    expect(initiate.searchParams.get('loopback_port')).toBe('17421')
    expect(initiate.searchParams.get('client_state')).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(tauriCore.invoke).toHaveBeenCalledWith('start_oauth_server', {
      clientState: initiate.searchParams.get('client_state'),
    })
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it.each(['token=attacker-token', 'error=access_denied', 'error=invalid_request'])(
    'ignores callbacks without state: %s',
    async (params) => {
      openUrlSpy.mockImplementation(async (url) => {
        callback({ payload: { url: `http://localhost:17421/?${params}` } })
        respond(url, { token: 'real-token' })
      })
      expect(await startSsoFlowLoopback('http://localhost:8000')).toBe('real-token')
    },
  )

  it('ignores wrong origin, port, path, state, duplicate state, and malformed events', async () => {
    openUrlSpy.mockImplementation(async (initiate) => {
      const state = new URL(initiate).searchParams.get('client_state')!
      for (const url of [
        `https://attacker.test/?client_state=${state}&token=attacker`,
        `http://user:password@localhost:17421/?client_state=${state}&token=attacker`,
        `http://localhost:17422/?client_state=${state}&token=attacker`,
        `http://localhost:17421/other?client_state=${state}&token=attacker`,
        `http://localhost:17421/?client_state=${'x'.repeat(43)}&token=attacker`,
        `http://localhost:17421/?client_state=${state}&client_state=other&token=attacker`,
        'not a URL',
      ]) {
        callback({ payload: { url } })
      }
      respond(initiate, { token: 'real-token' })
    })
    expect(await startSsoFlowLoopback('http://localhost:8000')).toBe('real-token')
  })

  it('accepts valid callbacks using the URL.canParse polyfill while ignoring malformed callbacks', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(URL, 'canParse')
    Object.defineProperty(URL, 'canParse', { configurable: true, value: undefined })
    try {
      installUrlCanParsePolyfill()
      openUrlSpy.mockImplementation(async (url) => {
        callback({ payload: { url: 'not a URL' } })
        respond(url, { client_state: 'wrong-state', token: 'attacker-token' })
        respond(url, { token: 'real-token' })
      })
      expect(await startSsoFlowLoopback('http://localhost:8000')).toBe('real-token')
      expect(unlistenFn).toHaveBeenCalledTimes(1)
    } finally {
      if (descriptor) {
        Object.defineProperty(URL, 'canParse', descriptor)
      } else {
        Reflect.deleteProperty(URL, 'canParse')
      }
    }
  })

  it('uses a fresh nonce after an earlier attempt, rejecting its replay', async () => {
    const states: string[] = []
    openUrlSpy.mockImplementation(async (url) => {
      states.push(new URL(url).searchParams.get('client_state')!)
      if (states.length === 2) {
        respond(url, { client_state: states[0], token: 'old-token' })
      }
      respond(url, { token: `token-${states.length}` })
    })
    expect(await startSsoFlowLoopback('http://localhost:8000')).toBe('token-1')
    expect(await startSsoFlowLoopback('http://localhost:8000')).toBe('token-2')
    expect(states[0]).not.toBe(states[1])
  })

  it('only surfaces an error code from the matching attempt, never free-text details', async () => {
    openUrlSpy.mockImplementation(async (url) =>
      respond(url, { error: 'access_denied', error_description: 'Untrusted text' }),
    )
    await expect(startSsoFlowLoopback('http://localhost:8000')).rejects.toMatchObject({
      code: 'access_denied',
      message: 'access_denied',
    })
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('rejects a matching callback without a token', async () => {
    openUrlSpy.mockImplementation(async (url) => respond(url, {}))
    await expect(startSsoFlowLoopback('http://localhost:8000')).rejects.toThrow('No token in SSO callback')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('fails closed when an older backend returns an unbound token', async () => {
    openUrlSpy.mockImplementation(async () =>
      callback({ payload: { url: 'http://localhost:17421/?token=legacy-token' } }),
    )
    const promise = startSsoFlowLoopback('http://localhost:8000', 1)
    await getClock().tickAsync(10)
    expect(await promise).toBeNull()
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })

  it('cleans up the listener when browser opening fails', async () => {
    openUrlSpy.mockRejectedValue(new Error('Browser unavailable'))
    await expect(startSsoFlowLoopback('http://localhost:8000')).rejects.toThrow('Browser unavailable')
    expect(unlistenFn).toHaveBeenCalledTimes(1)
  })
})
