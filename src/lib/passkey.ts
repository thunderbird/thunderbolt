/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { authRequestHeaders } from '@/contexts/auth-context'
import { selectPasskeyEnabled, useConfigStore } from '@/api/config-store'
import { isSsoMode } from '@/lib/auth-mode'
import { getPlatform } from '@/lib/platform'
import {
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

/**
 * Passkey (WebAuthn) ceremony module — THU-790 POC, sign-in only.
 *
 * This is the piece we deliberately own instead of Better Auth's `passkeyClient()`
 * (the "closed box"): it calls the plugin's server endpoints directly via
 * `authClient.$fetch` and drives the browser ceremony with `@simplewebauthn/browser`.
 * Owning it is what lets Phase B add the PRF extension to these same options objects
 * later without reworking the sign-in path.
 *
 * The plugin round-trips the WebAuthn challenge through a signed cookie, so every
 * ceremony call sets `credentials: 'include'`. The app runs bearer-token auth with
 * `credentials: 'omit'` in consumer mode (see `buildFetchOptions`), so without this
 * override the challenge cookie would never be sent back and verification would fail.
 */

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
   * Send cookies with the request. Required ONLY for the generate/verify pairs,
   * which round-trip the WebAuthn challenge through a signed cookie. It must stay
   * OFF for every other call: the app authenticates by bearer token, and sending
   * cookies also sends any stale Better Auth session cookie the browser still
   * holds — the bearer plugin appends its token cookie *after* that stale one, and
   * the stale (first) value wins on parse, so the request 401s despite a valid
   * token. List/delete therefore rely on the bearer default (`credentials: omit`).
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
 * ceremony (native passkey bridges are Phase-B/Tauri work), so we also require the
 * plain web platform. SSO deployments swap the whole auth surface, so exclude them.
 */
export const isPasskeyCapable = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function' &&
  getPlatform() === 'web' &&
  !isSsoMode()

/**
 * Whether passkey UI should be offered: the deployment enabled it (RP ID configured,
 * surfaced as `passkeyEnabled` on GET /config) AND this runtime can run a ceremony.
 */
export const usePasskeyAvailable = (): boolean => {
  const enabled = useConfigStore((state) => selectPasskeyEnabled(state.config))
  return enabled && isPasskeyCapable()
}

/** True when a ceremony rejection is the user dismissing/cancelling the prompt. */
export const isPasskeyCancellation = (error: unknown): boolean =>
  error instanceof WebAuthnError && (error.name === 'NotAllowedError' || error.code === 'ERROR_CEREMONY_ABORTED')

/**
 * Register a new passkey for the currently authenticated (non-anonymous) user.
 * Throws on ceremony failure or server rejection; call sites translate cancellation
 * via {@link isPasskeyCancellation}.
 */
export const registerPasskey = async (authClient: AuthClient, name?: string): Promise<PasskeyRecord> => {
  const optionsJSON = await ceremonyFetch<PublicKeyCredentialCreationOptionsJSON>(
    authClient,
    '/passkey/generate-register-options',
    { method: 'GET', withChallengeCookie: true },
  )

  const attResp = await startRegistration({ optionsJSON })

  return ceremonyFetch<PasskeyRecord>(authClient, '/passkey/verify-registration', {
    method: 'POST',
    body: { response: attResp, name },
    withChallengeCookie: true,
  })
}

/**
 * Authenticate with a passkey (usernameless / discoverable credential). On success
 * the bearer token is persisted by the auth client's `onSuccess` handler, then the
 * session atom is refreshed so the app flips to the authenticated state.
 */
export const signInWithPasskey = async (authClient: AuthClient): Promise<{ userId?: string }> => {
  const optionsJSON = await ceremonyFetch<PublicKeyCredentialRequestOptionsJSON>(
    authClient,
    '/passkey/generate-authenticate-options',
    { method: 'GET', withChallengeCookie: true },
  )

  const asseResp = await startAuthentication({ optionsJSON })

  await ceremonyFetch(authClient, '/passkey/verify-authentication', {
    method: 'POST',
    body: { response: asseResp },
    withChallengeCookie: true,
  })

  // Better Auth only refreshes the reactive session atom for its own built-in
  // sign-in paths; our custom verify-authentication call is not one of them, so
  // `useSession` would stay stale until a reload. Fetch the fresh session and
  // push it into the atom directly — the same pattern `hydrateSessionFromCache`
  // uses in auth-context — so the app flips to the authenticated state at once.
  const { data } = await authClient.getSession()
  const sessionAtom = authClient.$store.atoms.session
  sessionAtom.set({ ...sessionAtom.get(), data, isPending: false })
  return { userId: data?.user?.id }
}

/** List the current user's registered passkeys. */
export const listPasskeys = (authClient: AuthClient): Promise<PasskeyRecord[]> =>
  ceremonyFetch<PasskeyRecord[]>(authClient, '/passkey/list-user-passkeys', { method: 'GET' })

/** Delete one of the current user's passkeys by row id. */
export const deletePasskey = (authClient: AuthClient, id: string): Promise<unknown> =>
  ceremonyFetch(authClient, '/passkey/delete-passkey', { method: 'POST', body: { id } })
