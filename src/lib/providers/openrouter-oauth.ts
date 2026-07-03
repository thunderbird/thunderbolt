/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getProviderDefinition } from '../../../shared/providers'
import { generateCodeChallenge, generateCodeVerifier } from '../pkce'

/**
 * OpenRouter OAuth PKCE — standalone-safe (no client secret, no backend). The
 * flow ends by exchanging the authorization code for a *durable user API key*
 * (not a refreshable token), which we then store as the provider credential.
 *
 * Desktop uses the same localhost-loopback plumbing as integrations
 * (`start_oauth_server` Rust command + `oauth-callback` event); web uses a
 * full-page redirect to a callback route that calls `exchangeOpenRouterCode`.
 */

const openrouterTimeoutMs = 5 * 60 * 1000

/** Build the OpenRouter authorize URL for a given loopback/redirect callback. */
export const buildOpenRouterAuthUrl = (redirectUri: string, codeChallenge: string): string => {
  const def = getProviderDefinition('openrouter')
  const url = new URL(def.oauth!.authorizeUrl)
  url.searchParams.set('callback_url', redirectUri)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Exchange an authorization code + verifier for a durable OpenRouter API key. */
export const exchangeOpenRouterCode = async (
  code: string,
  codeVerifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> => {
  const def = getProviderDefinition('openrouter')
  const res = await fetchFn(def.oauth!.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: codeVerifier, code_challenge_method: 'S256' }),
  })
  if (!res.ok) {
    throw new Error(`OpenRouter key exchange failed (${res.status})`)
  }
  const json = (await res.json()) as { key?: string }
  if (!json.key) {
    throw new Error('OpenRouter did not return an API key')
  }
  return json.key
}

/** Injectable Tauri/browser primitives so the loopback flow is unit-testable. */
export type OpenRouterLoopbackDeps = {
  startServer: () => Promise<number>
  listenCallback: (handler: (url: string) => void) => Promise<() => void>
  openUrl: (url: string) => Promise<void>
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * Run the desktop loopback OpenRouter flow. Returns the API key, or `null` on
 * timeout/cancellation. Mirrors `startOAuthFlowLoopback` but for OpenRouter's
 * code→key exchange.
 */
export const connectOpenRouterLoopback = async (deps: OpenRouterLoopbackDeps): Promise<string | null> => {
  const timeoutMs = deps.timeoutMs ?? openrouterTimeoutMs
  const port = await deps.startServer()
  const redirectUri = `http://localhost:${port}`

  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  let unlisten: (() => void) | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timedOut = Symbol('openrouter-timeout')
  try {
    let resolveUrl!: (url: string) => void
    const urlPromise = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })
    unlisten = await deps.listenCallback(resolveUrl)

    await deps.openUrl(buildOpenRouterAuthUrl(redirectUri, codeChallenge))

    const outcome = await Promise.race([
      urlPromise,
      new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(() => resolve(timedOut), timeoutMs)
      }),
    ])
    if (outcome === timedOut) {
      return null
    }

    const url = new URL(outcome)
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (error) {
      throw new Error(error)
    }
    const code = url.searchParams.get('code')
    if (!code) {
      throw new Error('Missing code in OpenRouter callback')
    }
    return await exchangeOpenRouterCode(code, codeVerifier, deps.fetchFn)
  } finally {
    clearTimeout(timeoutId)
    unlisten?.()
  }
}
