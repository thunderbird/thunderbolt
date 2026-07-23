/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'

/**
 * Client surface the device-grant calls depend on. Narrowed to `$fetch` so the
 * approval logic can be unit-tested with a tiny fake instead of the whole auth
 * client (DI over module mocking).
 */
export type DeviceGrantClient = Pick<AuthClient, '$fetch'>

/** Device-authorization record status returned by Better Auth's `GET /device`. */
export type DeviceCodeStatus = 'pending' | 'approved' | 'denied'

/** Why a device-grant call could not complete, with user-facing copy. */
export type DeviceGrantFailure = { reason: 'expired' | 'invalid' | 'unavailable'; message: string }

export type VerifyResult = { ok: true; status: DeviceCodeStatus } | ({ ok: false } & DeviceGrantFailure)

export type ActionResult = { ok: true } | ({ ok: false } & DeviceGrantFailure)

const failureMessages: Record<DeviceGrantFailure['reason'], string> = {
  expired: 'This sign-in request has expired. Start a new one from your terminal.',
  invalid: "That code isn't valid or has already been used. Check your terminal and try again.",
  unavailable: 'The sign-in service is unavailable right now. Check your connection and try again.',
}

/**
 * Normalize Better Auth's OAuth-style device error body (`{ error, error_description }`)
 * into a typed failure. Transport and server errors stay distinct from invalid codes.
 */
const toFailure = (error: unknown): DeviceGrantFailure => {
  const details = error as { error?: unknown; status?: unknown } | null
  const status = typeof details?.status === 'number' ? details.status : undefined
  const unavailable = status === 0 || (status === undefined ? error instanceof Error : status >= 500)
  if (unavailable) {
    const underlyingError = details?.error instanceof Error ? details.error : error
    console.error('Device grant request failed', underlyingError)
    return { reason: 'unavailable', message: failureMessages.unavailable }
  }

  const code = details?.error
  const reason = code === 'expired_token' ? 'expired' : 'invalid'
  return { reason, message: failureMessages[reason] }
}

/**
 * Verify a user code and claim it for the current session. Better Auth's `GET /device`
 * binds the pending code to the authenticated caller — this claim is required before
 * approve/deny will succeed. Returns the record status (`pending` once claimed, or the
 * terminal status if it was already handled).
 */
export const verifyDeviceCode = async (client: DeviceGrantClient, userCode: string): Promise<VerifyResult> => {
  try {
    const { data, error } = await client.$fetch<{ user_code: string; status: DeviceCodeStatus }>('/device', {
      method: 'GET',
      query: { user_code: userCode },
    })
    if (error || !data) {
      return { ok: false, ...toFailure(error) }
    }
    return { ok: true, status: data.status }
  } catch (error) {
    return { ok: false, ...toFailure(error) }
  }
}

/** Approve a claimed device-authorization request, granting the CLI a session. */
export const approveDeviceCode = (client: DeviceGrantClient, userCode: string): Promise<ActionResult> =>
  runAction(client, '/device/approve', userCode)

/** Deny a claimed device-authorization request. */
export const denyDeviceCode = (client: DeviceGrantClient, userCode: string): Promise<ActionResult> =>
  runAction(client, '/device/deny', userCode)

const runAction = async (client: DeviceGrantClient, path: string, userCode: string): Promise<ActionResult> => {
  try {
    const { error } = await client.$fetch<{ success: boolean }>(path, {
      method: 'POST',
      body: { userCode },
    })
    if (!error) {
      return { ok: true }
    }
    return { ok: false, ...toFailure(error) }
  } catch (error) {
    return { ok: false, ...toFailure(error) }
  }
}

/** Uppercase + trim so pasted/typed codes match the terminal's display. */
export const normalizeUserCode = (raw: string): string => raw.trim().toUpperCase()
