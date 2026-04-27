/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type HttpClient } from '@/contexts'
import { getAuthToken, getDeviceId } from '@/lib/auth-token'

// =============================================================================
// Response types (matching backend)
// =============================================================================

export type RegisterDeviceResponse = { trusted: true; envelope: string | null } | { trusted: false }

type StoreEnvelopeResponse = { trusted: true }

type FetchEnvelopeResponse = { trusted: boolean; wrappedCK: string }

type FetchCanaryResponse = { canaryIv: string; canaryCtext: string }

// =============================================================================
// Auth headers helper
// =============================================================================

export const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const deviceId = getDeviceId()
  if (deviceId) {
    headers['X-Device-ID'] = deviceId
  }
  return headers
}

// =============================================================================
// API functions
// =============================================================================

/** Register (or re-identify) this device with the server. */
export const registerDevice = async (
  httpClient: HttpClient,
  params: { deviceId: string; publicKey: string; mlkemPublicKey: string; name?: string },
): Promise<RegisterDeviceResponse> =>
  httpClient
    .post('devices', {
      json: params,
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<RegisterDeviceResponse>()

/** Store a wrapped content key (envelope) for a device. Optionally includes canary on first setup or secret for recovery. */
export const storeEnvelope = async (
  httpClient: HttpClient,
  params: { deviceId: string; wrappedCK: string; canaryIv?: string; canaryCtext?: string; canarySecret?: string },
): Promise<StoreEnvelopeResponse> => {
  const { deviceId, ...body } = params
  return httpClient
    .post(`devices/${encodeURIComponent(deviceId)}/envelope`, {
      json: body,
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<StoreEnvelopeResponse>()
}

/** Fetch the wrapped content key for the current device. */
export const fetchMyEnvelope = async (httpClient: HttpClient): Promise<FetchEnvelopeResponse> =>
  httpClient
    .get('devices/me/envelope', {
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<FetchEnvelopeResponse>()

/** Fetch the canary for recovery key verification. */
export const fetchCanary = async (httpClient: HttpClient): Promise<FetchCanaryResponse> =>
  httpClient
    .get('encryption/canary', {
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<FetchCanaryResponse>()

/** Deny a pending device (called by a trusted device). Requires canary proof-of-CK-possession. */
export const denyDevice = async (httpClient: HttpClient, deviceId: string, canarySecret: string): Promise<void> => {
  await httpClient.post(`devices/${encodeURIComponent(deviceId)}/deny`, {
    json: { canarySecret },
    headers: authHeaders(),
    credentials: 'omit',
  })
}

/** Revoke a device. Includes canary proof-of-CK-possession when E2EE is active. */
export const revokeDevice = async (httpClient: HttpClient, deviceId: string, canarySecret?: string): Promise<void> => {
  await httpClient.post(`account/devices/${encodeURIComponent(deviceId)}/revoke`, {
    json: canarySecret ? { canarySecret } : {},
    headers: authHeaders(),
    credentials: 'omit',
  })
}

/** Cancel this device's pending approval state (called by the pending device itself). */
export const cancelPending = async (httpClient: HttpClient): Promise<void> => {
  await httpClient.post('devices/me/cancel-pending', {
    headers: authHeaders(),
    credentials: 'omit',
  })
}

/** Check if the user has encryption set up (canary exists on server). */
export const checkCanaryExists = async (httpClient: HttpClient): Promise<boolean> => {
  try {
    await httpClient
      .get('encryption/canary', {
        headers: authHeaders(),
        credentials: 'omit',
      })
      .json()
    return true
  } catch (err) {
    if (err instanceof Error && 'response' in err) {
      const status = (err as Error & { response: { status: number } }).response.status
      if (status === 404) {
        return false
      }
    }
    throw err
  }
}
