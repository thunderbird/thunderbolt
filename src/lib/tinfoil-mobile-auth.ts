/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { openUrl } from '@tauri-apps/plugin-opener'
import { z } from 'zod'
import { currentOAuthReturnPath, oauthReturnPath } from './oauth-return-route'
import { i18n } from '@/i18n'
import { mobileOAuthRedirectUri } from './oauth-redirect'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'
import type { ProviderConnectionAttempt } from './provider-connection-attempt'
import {
  getTinfoilAuthorizationUrl,
  tinfoilAuth,
  TinfoilConnectionError,
  type TinfoilCredentials,
} from './tinfoil-auth'

export type TinfoilReturnContext = 'onboarding' | 'connections'
const storageKey = 'thunderbolt.tinfoil.mobile-authorization'
const lifetimeMs = 10 * 60_000
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const flowSchema = z.object({
  state: nonce,
  verifier: nonce,
  context: z.enum(['onboarding', 'connections']),
  returnTo: z.string().optional(),
  attempt: z.object({ provider: z.literal('tinfoil'), revision: z.string() }),
  createdAt: z.number().finite(),
})

export type TinfoilMobileReturn = {
  id: string
  context: TinfoilReturnContext
  returnTo: string
  attempt: ProviderConnectionAttempt
  complete: () => Promise<TinfoilCredentials>
  cancel: () => void
}
let mobileReturn: TinfoilMobileReturn | null = null

/** Only the setup surface that initiated authorization may finish its connection. */
export const getTinfoilMobileReturn = (context?: TinfoilReturnContext): TinfoilMobileReturn | null =>
  context === undefined || mobileReturn?.context === context ? mobileReturn : null

/** Release the in-memory code after setup finishes; repeated deep links cannot redeem it again. */
export const clearTinfoilMobileReturn = (id: string): void => {
  if (mobileReturn?.id === id) {
    mobileReturn = null
  }
}

const defaultDependencies = {
  storage: () => localStorage,
  currentPath: currentOAuthReturnPath,
  openUrl,
  verifier: generateCodeVerifier,
  challenge: generateCodeChallenge,
  now: Date.now,
  exchange: tinfoilAuth.exchangeCode,
}

/** Persist PKCE before leaving for the browser, so OS termination does not lose the mobile connection. */
export const startTinfoilMobileConnection = async (
  context: TinfoilReturnContext,
  attempt: ProviderConnectionAttempt,
  signal: AbortSignal,
  dependencies: Partial<typeof defaultDependencies> = {},
): Promise<void> => {
  const deps = { ...defaultDependencies, ...dependencies }
  signal.throwIfAborted()
  const returnTo = deps.currentPath()
  const verifier = deps.verifier()
  const state = deps.verifier()
  const challenge = await deps.challenge(verifier)
  signal.throwIfAborted()
  const storage = deps.storage()
  const storedFlow = JSON.stringify({
    state,
    verifier,
    context,
    returnTo,
    attempt,
    createdAt: deps.now(),
  })
  storage.setItem(storageKey, storedFlow)
  try {
    await deps.openUrl(getTinfoilAuthorizationUrl({ challenge, state, redirectUri: mobileOAuthRedirectUri }))
  } catch (error) {
    if (storage.getItem(storageKey) === storedFlow) {
      storage.removeItem(storageKey)
    }
    throw error
  }
}

/** Explicit cancellation forgets pending PKCE; unmount alone must survive a mobile app restart. */
export const cancelTinfoilMobileConnection = (): void => {
  mobileReturn?.cancel()
  mobileReturn = null
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // Storage cleanup is best-effort; the in-memory exchange must always be cancelled.
  }
}

/** Validate the app link and nonce, then hold one token exchange for the returning setup surface. */
export const captureTinfoilMobileReturn = (
  url: URL,
  dependencies: Partial<typeof defaultDependencies> = {},
): TinfoilMobileReturn | null => {
  if (`${url.origin}${url.pathname}` !== mobileOAuthRedirectUri || url.hash || url.username || url.password) {
    return null
  }
  const state = url.searchParams.get('state')
  if (url.searchParams.getAll('state').length !== 1) {
    return null
  }
  if (mobileReturn?.id === state) {
    return mobileReturn
  }
  const deps = { ...defaultDependencies, ...dependencies }
  const storage = deps.storage()
  const flow = (() => {
    try {
      return flowSchema.safeParse(JSON.parse(storage.getItem(storageKey) ?? 'null'))
    } catch {
      return null
    }
  })()
  if (!flow?.success || flow.data.state !== state) {
    return null
  }
  storage.removeItem(storageKey)
  const age = deps.now() - flow.data.createdAt
  const code = url.searchParams.get('code')
  const invalid =
    age < 0 ||
    age > lifetimeMs ||
    !code?.trim() ||
    url.searchParams.getAll('code').length !== 1 ||
    url.searchParams.has('error')
  const controller = new AbortController()
  let completion: Promise<TinfoilCredentials> | undefined
  mobileReturn = {
    id: flow.data.state,
    context: flow.data.context,
    returnTo: flow.data.context === 'onboarding' ? '/chats/new' : oauthReturnPath(flow.data.returnTo),
    attempt: flow.data.attempt,
    cancel: () => controller.abort(),
    complete: () => {
      completion ??= (async () => {
        controller.signal.throwIfAborted()
        if (invalid) {
          throw new TinfoilConnectionError(i18n._(msg`Could not connect to Tinfoil. Try again, or use an API key.`))
        }
        return deps.exchange(
          { code: code!, verifier: flow.data.verifier, redirectUri: mobileOAuthRedirectUri },
          controller.signal,
        )
      })()
      return completion
    },
  }
  return mobileReturn
}
