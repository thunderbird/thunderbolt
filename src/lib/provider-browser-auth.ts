/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { currentOAuthReturnPath, oauthReturnPath } from './oauth-return-route'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'
import { exchangeOpenRouterCode } from './openrouter-auth'
import { getTinfoilAuthorizationUrl, tinfoilAuth, type TinfoilCredentials } from './tinfoil-auth'
import type { ProviderConnectionAttempt } from './provider-connection-attempt'
import { getIdentitySignal } from './identity-lifetime'
type Credentials = TinfoilCredentials | { access_token: string }

type Provider = 'openrouter' | 'tinfoil'
type Context = 'connections' | 'onboarding'
const key = 'thunderbolt.provider.browser-authorization'
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const schema = z.object({
  provider: z.enum(['openrouter', 'tinfoil']),
  context: z.enum(['connections', 'onboarding']),
  returnTo: z.string().optional(),
  state: nonce,
  verifier: nonce,
  redirectUri: z.string().url(),
  createdAt: z.number().finite(),
  attempt: z.object({ provider: z.enum(['openrouter', 'tinfoil']), revision: z.string() }),
})
type BrowserReturn = {
  id: string
  context: Context
  returnTo: string
  callbackUrl: string
  attempt: ProviderConnectionAttempt
  complete: () => Promise<Credentials>
  cancel: () => void
}
let returned: BrowserReturn | null = null
const defaults = {
  storage: () => sessionStorage,
  origin: () => window.location.origin,
  currentPath: currentOAuthReturnPath,
  navigate: (url: string) => window.location.assign(url),
  verifier: generateCodeVerifier,
  challenge: generateCodeChallenge,
  now: Date.now,
  exchangeTinfoil: tinfoilAuth.exchangeCode,
  exchangeOpenRouter: exchangeOpenRouterCode,
}

/** Persist tab-scoped PKCE before navigating away; never store an access token in the handoff. */
export const startProviderBrowserConnection = async (
  provider: Provider,
  context: Context,
  attempt: ProviderConnectionAttempt,
  callerSignal: AbortSignal,
  overrides: Partial<typeof defaults> = {},
) => {
  const signal = AbortSignal.any([callerSignal, getIdentitySignal()])
  const deps = { ...defaults, ...overrides }
  signal.throwIfAborted()
  const returnTo = deps.currentPath()
  const state = deps.verifier()
  const verifier = deps.verifier()
  const challenge = await deps.challenge(verifier)
  signal.throwIfAborted()
  const redirectUri = `${deps.origin()}/oauth/${provider}${provider === 'openrouter' ? `/${state}` : ''}`
  const url = new URL(
    provider === 'tinfoil'
      ? getTinfoilAuthorizationUrl({ challenge, state, redirectUri })
      : 'https://openrouter.ai/auth',
  )
  if (provider === 'openrouter') {
    url.search = new URLSearchParams({
      code_challenge: challenge,
      code_challenge_method: 'S256',
      key_label: 'Thunderbolt',
      callback_url: redirectUri,
      state,
    }).toString()
  }
  deps.storage().setItem(
    key,
    JSON.stringify({
      provider,
      context,
      returnTo,
      state,
      verifier,
      redirectUri,
      attempt,
      createdAt: deps.now(),
    }),
  )
  try {
    deps.navigate(url.toString())
  } catch (error) {
    deps.storage().removeItem(key)
    throw error
  }
}

/** The initiating surface alone owns completion of the one-use code exchange. */
export const getProviderBrowserReturn = (context?: Context) =>
  !context || returned?.context === context ? returned : null

/** Release the in-memory handoff once its destination has captured it. */
export const clearProviderBrowserReturn = (id: string) => {
  if (returned?.id === id) {
    returned = null
  }
}

/** Validate the exact callback and saved nonce before consuming any authorization state. */
export const captureProviderBrowserReturn = (
  url: URL,
  overrides: Partial<typeof defaults> = {},
): BrowserReturn | null => {
  const deps = { ...defaults, ...overrides }
  if (url.origin !== deps.origin() || url.hash || url.username || url.password) {
    return null
  }
  const state = url.searchParams.get('state') ?? url.pathname.match(/^\/oauth\/openrouter\/([A-Za-z0-9_-]{43})$/)?.[1]
  if (url.searchParams.getAll('state').length > 1) {
    return null
  }
  if (returned && returned.id === state && returned.callbackUrl === `${url.origin}${url.pathname}`) {
    return returned
  }
  const flow = (() => {
    try {
      const storage = deps.storage()
      const parsed = schema.safeParse(JSON.parse(storage.getItem(key) ?? 'null'))
      if (
        !parsed.success ||
        parsed.data.state !== state ||
        parsed.data.attempt.provider !== parsed.data.provider ||
        parsed.data.redirectUri !== `${url.origin}${url.pathname}`
      ) {
        return null
      }
      storage.removeItem(key)
      return parsed.data
    } catch {
      return null
    }
  })()
  if (!flow) {
    return null
  }
  const code = url.searchParams.get('code')
  const age = deps.now() - flow.createdAt
  const invalid =
    age < 0 ||
    age > 10 * 60_000 ||
    !code?.trim() ||
    url.searchParams.getAll('code').length !== 1 ||
    url.searchParams.has('error')
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, getIdentitySignal()])
  let completion: Promise<Credentials> | undefined
  returned = {
    callbackUrl: flow.redirectUri,
    id: flow.state,
    context: flow.context,
    returnTo: flow.context === 'onboarding' ? '/chats/new' : oauthReturnPath(flow.returnTo),
    attempt: flow.attempt,
    cancel: () => controller.abort(),
    complete: () =>
      (completion ??= (async () => {
        signal.throwIfAborted()
        if (invalid) {
          throw new Error('Invalid or expired provider authorization')
        }
        const credentials =
          flow.provider === 'tinfoil'
            ? await deps.exchangeTinfoil(
                { code: code!, verifier: flow.verifier, redirectUri: flow.redirectUri },
                signal,
              )
            : { access_token: await deps.exchangeOpenRouter(code!, flow.verifier, signal) }
        // The owning flow checks cancellation and releases an issued grant before discarding it.
        return credentials
      })()),
  }
  return returned
}

/** Explicit cancellation discards pending tab authorization; unmount preserves redirects. */
export const cancelProviderBrowserConnection = () => {
  returned?.cancel()
  returned = null
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Cancellation must still stop in-memory work when browser storage becomes unavailable.
  }
}
