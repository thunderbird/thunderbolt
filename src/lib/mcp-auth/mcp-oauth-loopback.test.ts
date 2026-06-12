/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { startMcpOAuthLoopback, type LoopbackDeps } from './mcp-oauth-loopback'

const port = 17421

/**
 * Builds injected Tauri deps whose `oauth-callback` listener resolves with the
 * given callback URL as soon as the browser is opened, so the happy path runs
 * without real Tauri or a real timer.
 */
const depsResolvingWith = (callbackUrl: string): LoopbackDeps & { openedWith: () => string | undefined } => {
  let onCallback: ((event: { payload: { url: string } }) => void) | undefined
  let openedWith: string | undefined
  return {
    invoke: (async () => port) as never,
    listen: (async (_event: string, handler: (event: { payload: { url: string } }) => void) => {
      onCallback = handler
      return () => {}
    }) as never,
    openUrl: (async (url: string) => {
      openedWith = url
      // Deliver the callback synchronously after the browser opens.
      onCallback?.({ payload: { url: callbackUrl } })
    }) as never,
    openedWith: () => openedWith,
  }
}

describe('startMcpOAuthLoopback', () => {
  it('builds the localhost redirect URI from the port and opens the built authorization URL', async () => {
    let redirectUriSeen: string | undefined
    const deps = depsResolvingWith('http://localhost:17421/?code=auth-code&state=nonce-1')

    const result = await startMcpOAuthLoopback({
      buildAuthorizationUrl: async (redirectUri) => {
        redirectUriSeen = redirectUri
        return new URL('https://auth.example.com/authorize?x=1')
      },
      deps,
    })

    expect(redirectUriSeen).toBe(`http://localhost:${port}`)
    expect(deps.openedWith()).toBe('https://auth.example.com/authorize?x=1')
    expect(result).toEqual({ code: 'auth-code', state: 'nonce-1', error: null, iss: null })
  })

  it('forwards the RFC 9207 iss parameter from the callback URL', async () => {
    const deps = depsResolvingWith(
      'http://localhost:17421/?code=auth-code&state=nonce-1&iss=https%3A%2F%2Fauth.example.com',
    )

    const result = await startMcpOAuthLoopback({
      buildAuthorizationUrl: async () => new URL('https://auth.example.com/authorize'),
      deps,
    })

    expect(result?.iss).toBe('https://auth.example.com')
  })

  it('surfaces the error_description from an error callback', async () => {
    const deps = depsResolvingWith('http://localhost:17421/?error=access_denied&error_description=User%20declined')

    const result = await startMcpOAuthLoopback({
      buildAuthorizationUrl: async () => new URL('https://auth.example.com/authorize'),
      deps,
    })

    expect(result).toEqual({ code: null, state: null, error: 'User declined', iss: null })
  })

  it('returns null when the user never completes auth (timeout)', async () => {
    const deps: LoopbackDeps = {
      invoke: (async () => port) as never,
      // Never delivers a callback.
      listen: (async () => () => {}) as never,
      openUrl: (async () => {}) as never,
    }

    const promise = startMcpOAuthLoopback({
      buildAuthorizationUrl: async () => new URL('https://auth.example.com/authorize'),
      timeoutMs: 1000,
      deps,
    })

    await getClock().tickAsync(1000)

    expect(await promise).toBeNull()
  })
})
