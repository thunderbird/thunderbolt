/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { z } from 'zod'
import { openUrl } from '@tauri-apps/plugin-opener'
import { exchangeOtariCode, getOtariAuthorizationUrl, normalizeOtariOrigin, revokeOtariToken } from '@/lib/otari-auth'
import { isAuthorizationResponseIssuerValid } from '@/lib/openrouter-auth'
import { generateCodeChallenge, generateCodeVerifier } from '@/lib/pkce'
import type { ProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import { isMobile, isTauri } from '@/lib/platform'
import { mobileOAuthRedirectUri } from '@/lib/oauth-redirect'
import { parseOAuthReturnPath } from '@/lib/oauth-return-route'
import { getIdentitySignal } from '@/lib/identity-lifetime'

export type OtariReturnContext = 'onboarding' | 'models' | 'connections'
const storageKey = 'thunderbolt.otari.authorization'
const lifetimeMs = 10 * 60_000
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const flowSchema = z.object({
  state: nonce,
  verifier: nonce,
  origin: z.string(),
  redirectUri: z.string(),
  returnTo: z.string(),
  context: z.enum(['onboarding', 'models', 'connections']),
  attempt: z.object({ provider: z.literal('otari'), revision: z.string() }),
  createdAt: z.number().finite(),
})

/** A credential-free route handoff. The one-use exchange and its result stay in memory. */
export type OtariBrowserReturn = {
  id: string
  origin: string
  context: OtariReturnContext
  attempt: ProviderConnectionAttempt
  returnTo: string
  error: MessageDescriptor | null
  complete: () => Promise<string>
  cancel: () => void
}
let browserReturn: OtariBrowserReturn | null = null

/** Match a return to the setup surface that initiated it. */
export const getOtariBrowserReturn = (context?: OtariReturnContext): OtariBrowserReturn | null =>
  !context || browserReturn?.context === context ? browserReturn : null

/** Drop the handoff after the owning setup component has captured it. */
export const clearOtariBrowserReturn = (id: string): void => {
  if (browserReturn?.id === id) {
    browserReturn = null
  }
}

/** Native mobile uses the same external browser and verified app link as Google and Microsoft. */
const isNativeMobile = () => isTauri() && isMobile()

const defaultDependencies = {
  mobile: isNativeMobile,
  // Mobile PKCE must survive the OS terminating the app while the system browser is open.
  storage: () => (isNativeMobile() ? window.localStorage : window.sessionStorage),
  currentUrl: () => new URL(window.location.href),
  navigate: (url: string): void | Promise<void> => (isNativeMobile() ? openUrl(url) : window.location.assign(url)),
  verifier: generateCodeVerifier,
  challenge: generateCodeChallenge,
  now: Date.now,
  exchange: exchangeOtariCode,
  revoke: revokeOtariToken,
}

/** Explicit cancellation retires the handoff even when its tab or mobile storage cannot be cleared. */
export const cancelOtariBrowserConnection = (): void => {
  browserReturn?.cancel()
  browserReturn = null
  try {
    defaultDependencies.storage().removeItem(storageKey)
  } catch {
    // Browser privacy settings may deny cleanup after authorization has already started.
  }
}

/** Restore the setup surface after browser Back, without restarting authorization. */
export const getOtariBrowserDraft = (
  context: OtariReturnContext,
  dependencies: Partial<typeof defaultDependencies> = {},
): { id: string; origin: string } | null => {
  const deps = { ...defaultDependencies, ...dependencies }
  // A cold mobile start must leave the request for the app-link listener to consume.
  if (deps.mobile()) {
    return null
  }
  try {
    const flow = flowSchema.safeParse(JSON.parse(deps.storage().getItem(storageKey) ?? 'null'))
    if (!flow.success || flow.data.context !== context) {
      return null
    }
    const current = deps.currentUrl()
    const age = deps.now() - flow.data.createdAt
    if (age < 0 || age > lifetimeMs || flow.data.returnTo !== `${current.pathname}${current.search}${current.hash}`) {
      return null
    }
    if (flow.data.redirectUri !== `${current.origin}/oauth/otari`) {
      return null
    }
    return { id: flow.data.state, origin: normalizeOtariOrigin(flow.data.origin) }
  } catch {
    return null
  }
}

/** Abandon only this tab's current request when Back returns to setup. */
export const discardOtariBrowserDraft = (id: string, storage?: Storage): void => {
  // Storage can be cleared or replaced between restoring the draft and mounting its owner.
  try {
    const tabStorage = storage ?? window.sessionStorage
    const flow = flowSchema.safeParse(JSON.parse(tabStorage.getItem(storageKey) ?? 'null'))
    if (flow.success && flow.data.state === id) {
      tabStorage.removeItem(storageKey)
    }
  } catch {
    return
  }
}

/** Save PKCE before opening the browser: same-tab on web, system browser and durable app-link state on mobile. */
export const startOtariBrowserConnection = async (
  origin: string,
  context: OtariReturnContext,
  callerSignal: AbortSignal,
  attempt: ProviderConnectionAttempt,
  dependencies: Partial<typeof defaultDependencies> = {},
): Promise<void> => {
  const signal = AbortSignal.any([callerSignal, getIdentitySignal()])
  signal.throwIfAborted()
  const deps = { ...defaultDependencies, ...dependencies }
  const current = deps.currentUrl()
  const base = normalizeOtariOrigin(origin)
  const returnTo = parseOAuthReturnPath(`${current.pathname}${current.search}${current.hash}`)
  if (!returnTo) {
    throw new Error('Invalid Otari return path')
  }
  const verifier = deps.verifier()
  const state = deps.verifier()
  const challenge = await deps.challenge(verifier)
  signal.throwIfAborted()
  const redirectUri = deps.mobile() ? mobileOAuthRedirectUri : `${current.origin}/oauth/otari`
  const flow = { state, verifier, origin: base, redirectUri, returnTo, context, attempt, createdAt: deps.now() }
  const storage = deps.storage()
  storage.setItem(storageKey, JSON.stringify(flow))
  const lifetime = deps.mobile() ? AbortSignal.any([signal, AbortSignal.timeout(lifetimeMs)]) : signal
  const cancelled = Promise.withResolvers<never>()
  const onAbort = () => {
    discardOtariBrowserDraft(state, storage)
    cancelled.reject(lifetime.reason)
  }
  lifetime.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([
      deps.navigate(getOtariAuthorizationUrl(base, { challenge, redirectUri, state })),
      cancelled.promise,
    ])
    if (deps.mobile()) {
      // The app-link listener resumes setup in a fresh route; unmount or Cancel ends this owner.
      await cancelled.promise
    }
  } catch (error) {
    discardOtariBrowserDraft(state, storage)
    throw error
  } finally {
    lifetime.removeEventListener('abort', onAbort)
  }
}

/** Validate and consume the saved request, then carry one exchange back to its setup screen. */
export const captureOtariBrowserReturn = (
  url: URL,
  dependencies: Partial<typeof defaultDependencies> = {},
): OtariBrowserReturn | null => {
  const deps = { ...defaultDependencies, ...dependencies }
  const state = url.searchParams.get('state')
  const redirectUri = deps.mobile() ? mobileOAuthRedirectUri : `${deps.currentUrl().origin}/oauth/otari`
  if (
    `${url.origin}${url.pathname}` !== redirectUri ||
    url.hash ||
    url.username ||
    url.password ||
    url.searchParams.getAll('state').length !== 1
  ) {
    return null
  }
  // React StrictMode can mount the callback twice; neither storage nor the one-use code is consumed twice.
  if (browserReturn?.id === state) {
    return browserReturn
  }
  // Storage access may fail if browser privacy settings change during the round trip.
  const flow = (() => {
    try {
      const storage = deps.storage()
      const parsed = flowSchema.safeParse(JSON.parse(storage.getItem(storageKey) ?? 'null'))
      if (!parsed.success) {
        storage.removeItem(storageKey)
        return null
      }
      if (parsed.data.state !== state) {
        return null
      }
      storage.removeItem(storageKey)
      return { ...parsed.data, origin: normalizeOtariOrigin(parsed.data.origin) }
    } catch {
      return null
    }
  })()
  if (!flow) {
    return null
  }
  const returnTo = parseOAuthReturnPath(flow.returnTo)
  if (!returnTo || flow.redirectUri !== redirectUri) {
    return null
  }
  const code = url.searchParams.get('code')
  const age = deps.now() - flow.createdAt
  const error =
    age < 0 || age > lifetimeMs
      ? msg`This connection expired. Please connect to Otari again.`
      : url.searchParams.get('error') === 'access_denied'
        ? msg`Connection cancelled. You can connect to Otari whenever you're ready.`
        : url.searchParams.has('error') ||
            !code?.trim() ||
            url.searchParams.getAll('code').length !== 1 ||
            !isAuthorizationResponseIssuerValid(url.searchParams, flow.origin)
          ? msg`Otari returned an invalid response. Please connect again.`
          : null
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, getIdentitySignal()])
  let completion: Promise<string> | undefined
  browserReturn = {
    id: flow.state,
    origin: flow.origin,
    returnTo,
    context: flow.context,
    attempt: flow.attempt,
    error,
    cancel: () => controller.abort(),
    complete: () => {
      completion ??= (async () => {
        signal.throwIfAborted()
        if (error) {
          throw new Error('Otari authorization failed')
        }
        const token = await deps.exchange(
          flow.origin,
          { code: code!, verifier: flow.verifier, redirectUri: flow.redirectUri },
          signal,
        )
        if (signal.aborted) {
          await deps.revoke(flow.origin, token)
          signal.throwIfAborted()
        }
        return token
      })()
      return completion
    },
  }
  return browserReturn
}

/** Claim only this provider's pending app-link nonce before the shared integrations callback routing. */
export const captureOtariMobileReturn = (url: URL): OtariBrowserReturn | null =>
  captureOtariBrowserReturn(url, { mobile: () => true, storage: () => window.localStorage })
