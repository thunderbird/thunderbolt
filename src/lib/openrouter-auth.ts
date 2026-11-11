/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { fetch as nativeFetch } from '@/lib/fetch'
import { http } from '@/lib/http'
import { generateCodeChallenge, generateCodeVerifier } from '@/lib/pkce'
import { isMobile, isTauri } from '@/lib/platform'
import { getIdentitySignal } from '@/lib/identity-lifetime'

export type ProviderAuthorizationConfig = {
  authorizationEndpoint: string
  authorizationResponseIssuer?: string
  loopbackHostname?: 'localhost' | '127.0.0.1'
  buildUrl?: (challenge: string, redirectUri: string, state: string) => string
}
const openRouterConfig: ProviderAuthorizationConfig = {
  authorizationEndpoint: 'https://openrouter.ai/auth',
}
const connectionTimeoutMs = 5 * 60 * 1000
export const oauthRequestTimeoutMs = 30_000

/** Token deadlines must cover body parsing, since a partial response must not hold a credential lock forever. */
export const createOAuthRequestSignal = (signal?: AbortSignal): AbortSignal => {
  const deadline = AbortSignal.timeout(oauthRequestTimeoutMs)
  return AbortSignal.any([getIdentitySignal(), deadline, ...(signal ? [signal] : [])])
}

const errorMessages = {
  cancelled: `OpenRouter connection was cancelled.`,
  timeout: `OpenRouter connection timed out. Please try again.`,
  pending: `An OpenRouter connection is already in progress.`,
  browser: `Use the browser redirect flow to connect to OpenRouter.`,
  mobile: `Use the authorization code option to connect to OpenRouter on this device.`,
  callback: `OpenRouter returned an invalid authorization response. Please try again.`,
  exchange: `Could not connect to OpenRouter. Please try again with a new authorization code.`,
  start: `Could not open the OpenRouter connection. Please try again.`,
}

/** A safe internal error that never includes a provider response or credential. */
class OpenRouterConnectionError extends Error {
  constructor(kind: keyof typeof errorMessages) {
    super(errorMessages[kind])
  }
}

/** Construct a stable error; setup surfaces translate their own user-facing copy. */
const connectionError = (kind: keyof typeof errorMessages): Error => new OpenRouterConnectionError(kind)

/** Cancellation remains recognizable to UI callers without exposing an abort reason. */
const cancellationError = (): DOMException => new DOMException(errorMessages.cancelled, 'AbortError')

export type OpenRouterConnectionOptions = { signal?: AbortSignal }

export type OpenRouterManualConnection = {
  authorizationUrl: string
  /** Keep in memory until the user pastes the code; never put it in a URL or log. */
  verifier: string
}

/** Browser and native boundaries, injectable without replacing shared modules in tests. */
export type OpenRouterAuthDependencies = {
  isTauri: () => boolean
  isMobile: () => boolean
  startLoopback: (flowId: string) => Promise<number>
  stopLoopback: (flowId: string) => Promise<void>
  listenForLoopback: (handler: (url: string) => void) => Promise<() => void>
  openExternalUrl: (url: string) => Promise<void>
  generateVerifier: () => string
  generateChallenge: (verifier: string) => Promise<string>
  generateState: () => string
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  timeoutMs: number
}

/** Builds an authorization URL with S256, adding a callback only for automatic flows. */
const buildAuthorizationUrl = (
  authorizationEndpoint: string,
  challenge: string,
  callbackUrl?: string,
  state?: string,
): string => {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('key_label', 'Thunderbolt')
  if (callbackUrl) {
    url.searchParams.set('callback_url', callbackUrl)
  }
  if (state) {
    url.searchParams.set('state', state)
  }
  return url.toString()
}

/** Rejects promptly on cancellation while still observing a late asynchronous completion. */
const withAbort = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Owns the deadline and cleanup, including listeners registered after cancellation. */
const createConnectionScope = (externalSignal: AbortSignal | undefined, timeoutMs: number) => {
  const controller = new AbortController()
  const cleanups = new Set<() => void>()
  let disposed = false
  const cancel = () => controller.abort(cancellationError())
  const timeout = setTimeout(() => controller.abort(connectionError('timeout')), timeoutMs)
  externalSignal?.addEventListener('abort', cancel, { once: true })
  if (externalSignal?.aborted) {
    cancel()
  }

  return {
    signal: controller.signal,
    addCleanup: (cleanup: () => void) => {
      if (disposed) {
        cleanup()
        return
      }
      cleanups.add(cleanup)
    },
    dispose: () => {
      disposed = true
      controller.abort(cancellationError())
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', cancel)
      for (const cleanup of cleanups) {
        cleanup()
      }
      cleanups.clear()
    },
  }
}

type CallbackData = { code?: unknown; state?: unknown; error?: unknown; clientId?: string | null }
type CallbackGrant = { code: string; clientId?: string }

/** Verifies the CSRF nonce before returning a code; provider error text is never surfaced. */
const readCallbackCode = (data: CallbackData, expectedState: string): string => {
  if (data.error) {
    // OpenRouter does not echo state when the user declines. Transport ownership
    // (the exact loopback origin) is checked before this function runs.
    throw connectionError(data.error === 'invalid_response' ? 'callback' : 'cancelled')
  }
  if (data.state !== expectedState || typeof data.code !== 'string' || !data.code.trim()) {
    throw connectionError('callback')
  }
  return data.code
}

/** Implements the PKCE-to-API-key protocol with provider-specific endpoints and injectable platform boundaries. */
export const createProviderAuthorization = (
  config: ProviderAuthorizationConfig,
  overrides: Partial<OpenRouterAuthDependencies> = {},
) => {
  const deps: OpenRouterAuthDependencies = {
    isTauri,
    isMobile,
    startLoopback: (flowId) => invoke<number>('start_oauth_server', { flowId }),
    stopLoopback: (flowId) => invoke<void>('stop_oauth_server', { flowId }),
    listenForLoopback: (handler) => listen<{ url: string }>('oauth-callback', (event) => handler(event.payload.url)),
    openExternalUrl: openUrl,
    generateVerifier: generateCodeVerifier,
    generateChallenge: generateCodeChallenge,
    generateState: generateCodeVerifier,
    fetch: nativeFetch,
    timeoutMs: connectionTimeoutMs,
    ...overrides,
  }
  let connecting = false

  /** Opens the browser immediately, validates the returned code, and returns a device-local API key. */
  const startConnection = async ({ signal: callerSignal }: OpenRouterConnectionOptions = {}): Promise<{
    code: string
    verifier: string
    redirectUri: string
    clientId?: string
  }> => {
    const signal = AbortSignal.any([getIdentitySignal(), ...(callerSignal ? [callerSignal] : [])])
    if (signal?.aborted) {
      throw cancellationError()
    }
    if (connecting) {
      throw connectionError('pending')
    }
    if (!deps.isTauri()) {
      throw connectionError('browser')
    }
    if (deps.isMobile()) {
      throw connectionError('mobile')
    }
    connecting = true
    const scope = createConnectionScope(signal, deps.timeoutMs)
    try {
      const verifier = deps.generateVerifier()
      const state = deps.generateState()
      const challenge = await withAbort(deps.generateChallenge(verifier), scope.signal)
      const startLoopback = async () => {
        const port = await deps.startLoopback(state)
        scope.addCleanup(() => {
          void deps.stopLoopback(state).catch(console.error)
        })
        return port
      }
      const origin = `http://localhost:${await withAbort(startLoopback(), scope.signal)}`
      const callbackUrl = `${origin.replace('localhost', config.loopbackHostname ?? 'localhost')}/`

      const authorizationUrl =
        config.buildUrl?.(challenge, callbackUrl, state) ??
        buildAuthorizationUrl(config.authorizationEndpoint, challenge, callbackUrl, state)

      let deliver!: (data: CallbackData) => void
      const callback = new Promise<CallbackGrant>((resolve, reject) => {
        deliver = (data) => {
          try {
            const code = readCallbackCode(data, state)
            resolve({ code, ...(data.clientId ? { clientId: data.clientId } : {}) })
          } catch (error) {
            reject(error)
          }
        }
      })
      // Observe callback failures immediately, including callbacks arriving while
      // the native browser opener is still resolving.
      const response = withAbort(callback, scope.signal)
      void response.catch(() => {})

      const register = async () => {
        const unlisten = await deps.listenForLoopback((value) => {
          const url = URL.canParse(value) ? new URL(value) : null
          if (!url || url.origin !== origin) {
            return
          }
          if (
            url.pathname !== '/' ||
            url.searchParams.getAll('code').length > 1 ||
            url.searchParams.getAll('state').length > 1 ||
            url.searchParams.getAll('client_id').length > 1 ||
            (config.authorizationResponseIssuer &&
              !isAuthorizationResponseIssuerValid(url.searchParams, config.authorizationResponseIssuer))
          ) {
            deliver({ error: 'invalid_response' })
            return
          }
          deliver({
            code: url.searchParams.get('code'),
            clientId: url.searchParams.get('client_id'),
            state: url.searchParams.get('state'),
            error: url.searchParams.get('error') || url.searchParams.get('error_description'),
          })
        })
        scope.addCleanup(unlisten)
      }
      await withAbort(register(), scope.signal)
      await withAbort(deps.openExternalUrl(authorizationUrl), scope.signal)

      const grant = await response
      return { ...grant, verifier, redirectUri: callbackUrl }
    } catch (error) {
      if (error instanceof OpenRouterConnectionError) {
        throw error
      }
      if (scope.signal.aborted) {
        throw scope.signal.reason
      }
      throw connectionError('start')
    } finally {
      scope.dispose()
      connecting = false
    }
  }

  return { startConnection }
}

/** Validate RFC 9207 when supplied, while supporting servers predating issuer responses. */
export const isAuthorizationResponseIssuerValid = (params: URLSearchParams, expected: string): boolean =>
  !params.has('iss') || (params.getAll('iss').length === 1 && params.get('iss') === expected)

/** Creates the configured OpenRouter PKCE-to-key flow. */
export const createOpenRouterAuth = (overrides: Partial<OpenRouterAuthDependencies> = {}) => {
  const authorization = createProviderAuthorization(openRouterConfig, overrides)
  /** Exchanges a one-use authorization code directly with OpenRouter, without a Thunderbolt server. */
  const exchangeCode = async (code: string, verifier: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) {
      throw cancellationError()
    }
    if (!code.trim() || !verifier.trim()) {
      throw connectionError('callback')
    }
    try {
      const response: unknown = await http
        .post('https://openrouter.ai/api/v1/auth/keys', {
          json: { code: code.trim(), code_verifier: verifier, code_challenge_method: 'S256' },
          credentials: 'omit',
          redirect: 'error',
          fetch: overrides.fetch ?? nativeFetch,
          signal: createOAuthRequestSignal(signal),
        })
        .json<unknown>()
      if (
        typeof response !== 'object' ||
        response === null ||
        !('key' in response) ||
        typeof response.key !== 'string' ||
        !response.key.trim()
      ) {
        throw connectionError('exchange')
      }
      return response.key
    } catch {
      if (signal?.aborted) {
        throw cancellationError()
      }
      throw connectionError('exchange')
    }
  }

  /** Prepares OpenRouter's copy-code flow for mobile or browsers that cannot receive callbacks. */
  const prepareManualConnection = async (): Promise<OpenRouterManualConnection> => {
    const verifier = (overrides.generateVerifier ?? generateCodeVerifier)()
    const challenge = await (overrides.generateChallenge ?? generateCodeChallenge)(verifier)
    return { authorizationUrl: buildAuthorizationUrl(openRouterConfig.authorizationEndpoint, challenge), verifier }
  }

  const startConnection = async (options: OpenRouterConnectionOptions = {}) => {
    const signal = AbortSignal.any([getIdentitySignal(), ...(options.signal ? [options.signal] : [])])
    const grant = await authorization.startConnection({ signal })
    signal.throwIfAborted()
    const token = await exchangeCode(grant.code, grant.verifier, signal)
    signal.throwIfAborted()
    return token
  }
  return { startConnection, prepareManualConnection, exchangeCode }
}

const openRouterAuth = createOpenRouterAuth()

/** Connects OpenRouter in a desktop system browser; returns the API key without persisting it. */
export const startOpenRouterConnection = openRouterAuth.startConnection

/** Prepares a PKCE authorization page that displays a code for the user to paste back on mobile. */
export const prepareOpenRouterManualConnection = openRouterAuth.prepareManualConnection

/** Exchanges a pasted code with the matching in-memory verifier directly with OpenRouter. */
export const exchangeOpenRouterCode = openRouterAuth.exchangeCode
