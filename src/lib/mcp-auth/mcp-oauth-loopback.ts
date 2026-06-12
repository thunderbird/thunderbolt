/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener'

/** Timeout for the user to complete auth in the browser (5 minutes). */
const loopbackTimeoutMs = 5 * 60 * 1000

/** Sentinel to distinguish a timeout from a real error without fragile string matching. */
const loopbackTimeout = Symbol('mcp-oauth-loopback-timeout')

/** Parameters parsed from the OAuth callback URL delivered to the loopback server. */
export type LoopbackCallbackParams = {
  code: string | null
  state: string | null
  error: string | null
  /** RFC 9207 issuer identifier, forwarded for callback validation. */
  iss: string | null
}

/** Tauri integration points, injectable so the flow is unit-testable without Tauri. */
export type LoopbackDeps = {
  invoke?: typeof tauriInvoke
  listen?: typeof tauriListen
  openUrl?: typeof tauriOpenUrl
}

type StartLoopbackArgs = {
  /**
   * Builds the authorization URL once the loopback redirect URI is known. The
   * redirect URI (`http://localhost:PORT`) must be the one registered with the
   * authorization server and embedded in the authorization request.
   */
  buildAuthorizationUrl: (redirectUri: string) => Promise<URL>
  timeoutMs?: number
  deps?: LoopbackDeps
}

/**
 * Runs a provider-agnostic desktop OAuth loopback flow for MCP servers.
 *
 * Binds the in-house Rust loopback server (`start_oauth_server`) to learn the
 * `http://localhost:PORT` redirect URI, hands that URI to `buildAuthorizationUrl`
 * so the caller can register a client + build the PKCE authorization URL against
 * it, registers the `"oauth-callback"` listener BEFORE opening the system browser
 * (avoiding a race), then waits for the callback URL racing a 5-minute timeout.
 * The callback's `code`, `state`, `error`/`error_description`, and RFC 9207 `iss`
 * are parsed and returned; `null` is returned on timeout.
 *
 * @returns The parsed callback params on completion, or `null` on timeout.
 */
export const startMcpOAuthLoopback = async ({
  buildAuthorizationUrl,
  timeoutMs = loopbackTimeoutMs,
  deps = {},
}: StartLoopbackArgs): Promise<LoopbackCallbackParams | null> => {
  const invoke = deps.invoke ?? tauriInvoke
  const listen = deps.listen ?? tauriListen
  const openUrl = deps.openUrl ?? tauriOpenUrl

  const port = await invoke<number>('start_oauth_server')
  const redirectUri = `http://localhost:${port}`

  let unlisten: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    let resolveUrl!: (url: string) => void
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })

    // Register the listener BEFORE opening the browser to avoid a race where the
    // callback arrives before we are listening for it.
    unlisten = await listen<{ url: string }>('oauth-callback', (event) => {
      resolveUrl(event.payload.url)
    })

    const authorizationUrl = await buildAuthorizationUrl(redirectUri)
    await openUrl(authorizationUrl.toString())

    const callbackUrl = await Promise.race([
      urlPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(loopbackTimeout), timeoutMs)
      }),
    ])

    const url = new URL(callbackUrl)
    return {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error_description') ?? url.searchParams.get('error'),
      iss: url.searchParams.get('iss'),
    }
  } catch (err) {
    if (err === loopbackTimeout) {
      return null
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    unlisten?.()
    // No cancel needed — the Rust server shuts itself down after one request.
  }
}
