/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The real `fetch`-backed {@link DeviceGrantTransport} that talks to Better Auth's
 * `deviceAuthorization` endpoints. This is the integration seam the pure state
 * machine ({@link pollForToken}) drives: `pollForToken`'s own tests inject a fake
 * transport, while this module's wire contract is covered directly in
 * `http-transport.test.ts` with an injected `fetchFn`.
 *
 * On approval the token endpoint mints a session and its endpoint-scoped backend
 * hook exposes the *signed* bearer via the `set-auth-token` response header. This
 * matches the session-cookie credential shape required by the bearer plugin; the
 * raw `access_token` body value is a bare session token and is deliberately not used.
 */

import { cliClientId } from './config.ts'
import type { DeviceCodeResponse, DeviceGrantTransport, TokenPollResult } from './device-grant.ts'

/** RFC 8628 grant type for the token exchange. */
const deviceCodeGrantType = 'urn:ietf:params:oauth:grant-type:device_code'

/** Raw `/device/code` 200 body (snake_case on the wire, RFC 8628 §3.2). */
type DeviceCodeBody = {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string
  readonly interval: number
  readonly expires_in: number
}

/** Raw `/device/token` 400 body carrying the RFC 8628 §3.5 error code. */
type DeviceTokenErrorBody = { readonly error: string; readonly error_description?: string }

/** Map a `/device/token` error code to a {@link TokenPollResult}; unknown codes
 *  are non-recoverable and surface loudly. */
const mapPollError = (error: string): TokenPollResult => {
  if (error === 'authorization_pending') return { kind: 'pending' }
  if (error === 'slow_down') return { kind: 'slow_down' }
  if (error === 'expired_token') return { kind: 'expired' }
  if (error === 'access_denied') return { kind: 'denied' }
  throw new Error(`device authorization failed: ${error}`)
}

/** The subset of `fetch` this transport uses; injectable so the wire contract can
 *  be unit-tested without a real network. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/**
 * Build a {@link DeviceGrantTransport} bound to a Better Auth base URL
 * (`…/v1/api/auth`, from {@link authBaseUrl}).
 *
 * @param authBaseUrl - the Better Auth base URL
 * @param fetchFn - HTTP fetch (defaults to the global `fetch`)
 */
export const createHttpTransport = (authBaseUrl: string, fetchFn: FetchFn = fetch): DeviceGrantTransport => ({
  requestCode: async () => {
    const res = await fetchFn(`${authBaseUrl}/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: cliClientId }),
    })
    if (!res.ok) {
      throw new Error(`device authorization request failed (${res.status} ${res.statusText})`)
    }
    const body = (await res.json()) as DeviceCodeBody
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      intervalSeconds: body.interval,
      expiresInSeconds: body.expires_in,
    } satisfies DeviceCodeResponse
  },

  pollToken: async (deviceCode) => {
    const res = await fetchFn(`${authBaseUrl}/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: deviceCodeGrantType,
        device_code: deviceCode,
        client_id: cliClientId,
      }),
    })
    if (res.ok) {
      const signedToken = res.headers.get('set-auth-token')
      if (!signedToken) {
        throw new Error('device token response is missing the set-auth-token header')
      }
      return { kind: 'approved', token: signedToken }
    }
    const body = (await res.json()) as DeviceTokenErrorBody
    return mapPollError(body.error)
  },
})
