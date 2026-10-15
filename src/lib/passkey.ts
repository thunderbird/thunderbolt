/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, type AuthClient } from '@/contexts'
import { authRequestHeaders } from '@/contexts/auth-context'
import { useQuery } from '@tanstack/react-query'
import { selectPasskeyEnabled, useConfigStore } from '@/api/config-store'
import { isSsoMode } from '@/lib/auth-mode'
import { markOnboardedForReturningUser } from '@/lib/returning-user-onboarding'
import { getPlatform } from '@/lib/platform'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

/**
 * Passkey (WebAuthn) sign-in, registration, and the PRF output that unlocks the
 * account's E2EE passkey slot.
 *
 * We call the plugin's endpoints ourselves instead of using Better Auth's
 * `passkeyClient()`, and run the browser side with `@simplewebauthn/browser`.
 * That's what lets us add the PRF extension to the ceremony options.
 */

/**
 * The browser ceremony library loads on first use: the sign-in form and onboarding
 * are in the entry bundle, and desktop builds or deployments with passkeys off
 * never run a ceremony. Every caller is a user action, so the chunk fetch is free.
 */
const loadWebAuthn = () => import('@simplewebauthn/browser')

/** One registered credential, as returned by the plugin's list endpoint. */
export type PasskeyRecord = {
  id: string
  name?: string
  credentialID: string
  createdAt: string
  deviceType: string
  backedUp: boolean
  aaguid?: string
}

type CeremonyRequest = {
  method: 'GET' | 'POST'
  body?: Record<string, unknown>
  /**
   * Send cookies. Only the generate/verify pairs need it, because the WebAuthn
   * challenge rides a signed cookie; the app otherwise omits credentials and
   * authenticates by bearer token. Elsewhere a stale session cookie could ride
   * along and 401 the request (see `stripStaleSessionCookie` on the backend).
   */
  withChallengeCookie?: boolean
}

/**
 * Call a passkey endpoint through the auth client's `$fetch` and unwrap its
 * `{ data, error }` result, throwing on error. Bearer auth and app headers come
 * from the client config; only challenge-carrying ceremony calls opt into cookies.
 */
const ceremonyFetch = async <T>(authClient: AuthClient, path: string, request: CeremonyRequest): Promise<T> => {
  const { data, error } = await authClient.$fetch<T>(path, {
    method: request.method,
    ...(request.body ? { body: request.body } : {}),
    ...(request.withChallengeCookie ? { credentials: 'include' as RequestCredentials } : {}),
    headers: authRequestHeaders(),
  })
  if (error) {
    throw error
  }
  return data as T
}

/**
 * True when this runtime can perform a WebAuthn ceremony at all. Feature detection
 * alone is not enough: a Tauri webview may expose `PublicKeyCredential` yet fail the
 * ceremony (there is no native passkey bridge for Tauri yet), so we also require the
 * plain web platform. SSO deployments swap the whole auth surface, so exclude them.
 */
export const isPasskeyCapable = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function' &&
  getPlatform() === 'web' &&
  !isSsoMode()

/**
 * Whether passkey UI should be offered: the operator turned passkeys on
 * (PASSKEY_ENABLED on a consumer-auth deployment, surfaced as `passkeyEnabled` on
 * GET /config) AND this runtime can run a ceremony.
 */
export const usePasskeyAvailable = (): boolean => {
  const enabled = useConfigStore((state) => selectPasskeyEnabled(state.config))
  return enabled && isPasskeyCapable()
}

/**
 * True when a ceremony rejection is the user dismissing/cancelling the prompt.
 * Checked by shape rather than `instanceof WebAuthnError`, which would pull the
 * lazily loaded library into the entry bundle.
 */
export const isPasskeyCancellation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'NotAllowedError' || (error as { code?: unknown }).code === 'ERROR_CEREMONY_ABORTED')

/**
 * True when the server refused to register a passkey because the session is more
 * than a day old. Better Auth requires a recent sign-in to add a sign-in method.
 */
export const isSessionNotFresh = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SESSION_NOT_FRESH'

/**
 * The WebAuthn PRF input. Not secret — the authenticator mixes it with a
 * per-credential secret, so the output is still unique to one passkey — but a
 * wire contract: changing it changes every passkey's output and strands every
 * enrolled slot.
 */
const passkeyPrfSalt = new TextEncoder().encode('thunderbolt-e2ee-passkey-prf-v1')

/**
 * The PRF extension input for every ceremony. SimpleWebAuthn spreads the options
 * straight into `navigator.credentials`, so the raw salt bytes pass through.
 */
const prfExtension = { prf: { eval: { first: passkeyPrfSalt } } } as AuthenticationExtensionsClientInputs

/** The 32-byte PRF output from a ceremony's extension results, or null when the provider has no PRF. */
const readPrfOutput = (results: AuthenticationExtensionsClientOutputs): Uint8Array | null => {
  const first = (results as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first
  return first ? new Uint8Array(first) : null
}

/**
 * Register a new passkey for the currently authenticated (non-anonymous) user,
 * requesting the PRF extension so the same passkey can unlock sync. Some
 * providers return the PRF output during creation and some only during an
 * assertion, so `prfOutput` may be null here even for a PRF-capable passkey —
 * {@link getPasskeyPrfOutput} gets it in that case.
 *
 * The PRF result is stripped before the response goes to the server: it is the
 * secret behind the passkey slot and never leaves this device.
 *
 * Throws on ceremony failure or server rejection; call sites translate cancellation
 * via {@link isPasskeyCancellation}.
 */
export const registerPasskey = async (
  authClient: AuthClient,
  name?: string,
): Promise<{ passkey: PasskeyRecord; prfOutput: Uint8Array | null }> => {
  const optionsJSON = await ceremonyFetch<PublicKeyCredentialCreationOptionsJSON>(
    authClient,
    '/passkey/generate-register-options',
    { method: 'GET', withChallengeCookie: true },
  )

  const { startRegistration } = await loadWebAuthn()
  const attResp = await startRegistration({
    optionsJSON: { ...optionsJSON, extensions: { ...optionsJSON.extensions, ...prfExtension } },
  })
  const prfOutput = readPrfOutput(attResp.clientExtensionResults)
  const { prf: _prf, ...clientExtensionResults } = attResp.clientExtensionResults as Record<string, unknown>

  const passkey = await ceremonyFetch<PasskeyRecord>(authClient, '/passkey/verify-registration', {
    method: 'POST',
    body: { response: { ...attResp, clientExtensionResults }, name },
    withChallengeCookie: true,
  })
  return { passkey, prfOutput }
}

/**
 * Get a passkey's PRF output with a local assertion — the secret behind the
 * passkey slot. Nothing is verified server-side (the challenge is random and
 * never sent anywhere): the output itself is the proof, since only the passkey
 * can produce it. Returns null when the provider does not support PRF.
 *
 * @param credentialId - base64url credential id; limits the prompt to that passkey
 */
export const getPasskeyPrfOutput = async (credentialId: string): Promise<Uint8Array | null> => {
  const { bufferToBase64URLString, startAuthentication } = await loadWebAuthn()
  const response = await startAuthentication({
    optionsJSON: {
      challenge: bufferToBase64URLString(crypto.getRandomValues(new Uint8Array(32)).buffer),
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      // Sign-in gets its RP ID from the server's options; this assertion never
      // reaches the server, so it reads it from config.
      rpId: useConfigStore.getState().config.passkeyRpId,
      userVerification: 'required',
      extensions: prfExtension,
    },
  })
  return readPrfOutput(response.clientExtensionResults)
}

/**
 * The account's passkey (one per account), or null. Bearer-only, like list.
 */
export const getAccountPasskey = async (authClient: AuthClient): Promise<PasskeyRecord | null> =>
  (await listPasskeys(authClient))[0] ?? null

/**
 * Cache key prefix for the account's passkey — invalidate it after creating or
 * removing one. The query appends the user id, so a different account signing in
 * never sees the previous one's passkey.
 */
export const accountPasskeyQueryKey = ['account-passkey'] as const

/**
 * The account's passkey, for full (non-anonymous) sessions where passkeys are
 * available. Anonymous sessions never query: the server refuses passkey routes
 * for them.
 *
 * `isSettled` tells "no passkey" apart from "not known yet": while the session or
 * the list is still loading the hook is unsettled, and only then may a caller
 * act on `passkey` being null.
 */
export const useAccountPasskey = () => {
  const authClient = useAuth()
  const passkeyAvailable = usePasskeyAvailable()
  const { data: session, isPending: isSessionPending } = authClient.useSession()
  const isFullUser = !!session?.user && session.user.isAnonymous !== true
  const query = useQuery({
    queryKey: [...accountPasskeyQueryKey, session?.user.id],
    queryFn: () => getAccountPasskey(authClient),
    enabled: passkeyAvailable && isFullUser,
  })
  const isUnavailable = !passkeyAvailable || (!isSessionPending && !isFullUser)
  const isSettled = isUnavailable || query.isSuccess || query.isError
  return {
    passkey: isUnavailable ? null : (query.data ?? null),
    isUnavailable,
    isSettled,
    isLoading: !isSettled,
    isError: query.isError,
  }
}

/**
 * Authenticate with a passkey (usernameless / discoverable credential). On success
 * the bearer token is persisted by the auth client's `onSuccess` handler, then the
 * session atom is refreshed so the app flips to the authenticated state.
 */
export const signInWithPasskey = async (authClient: AuthClient): Promise<{ userId: string }> => {
  const optionsJSON = await ceremonyFetch<PublicKeyCredentialRequestOptionsJSON>(
    authClient,
    '/passkey/generate-authenticate-options',
    { method: 'GET', withChallengeCookie: true },
  )

  // Sign-in needs no extensions, and a server-chosen PRF request must never reach
  // the authenticator: its output is the passkey slot's secret. Results are
  // stripped too, so a PRF output can never ride the verify request.
  const { extensions: _serverExtensions, ...signInOptions } = optionsJSON
  const { startAuthentication } = await loadWebAuthn()
  const asseResp = await startAuthentication({ optionsJSON: signInOptions })
  const { prf: _prf, ...clientExtensionResults } = asseResp.clientExtensionResults as Record<string, unknown>

  await ceremonyFetch(authClient, '/passkey/verify-authentication', {
    method: 'POST',
    body: { response: { ...asseResp, clientExtensionResults } },
    withChallengeCookie: true,
  })

  // Better Auth only refreshes the session atom for its own sign-in methods, so
  // push the new session in ourselves (as `hydrateSessionFromCache` does).
  const { data, error } = await authClient.getSession()
  if (error || !data) {
    throw error ?? new Error('Passkey sign-in succeeded but no session was returned')
  }
  // A passkey sign-in is always a returning user. Mark them onboarded before the
  // app flips to signed-in, or the onboarding wizard flashes.
  await markOnboardedForReturningUser(data.user)

  const sessionAtom = authClient.$store.atoms.session
  sessionAtom.set({ ...sessionAtom.get(), data, isPending: false })
  return { userId: data.user.id }
}

/** List the current user's registered passkeys. */
export const listPasskeys = (authClient: AuthClient): Promise<PasskeyRecord[]> =>
  ceremonyFetch<PasskeyRecord[]>(authClient, '/passkey/list-user-passkeys', { method: 'GET' })

/** Delete one of the current user's passkeys by row id. */
export const deletePasskey = (authClient: AuthClient, id: string): Promise<unknown> =>
  ceremonyFetch(authClient, '/passkey/delete-passkey', { method: 'POST', body: { id } })
