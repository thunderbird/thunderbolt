import type { KyInstance } from 'ky'
import { getAuthToken, getDeviceId } from '@/lib/auth-token'

// =============================================================================
// Response types (matching backend)
// =============================================================================

export type RegisterDeviceResponse =
  | { status: 'TRUSTED'; envelope: string | null }
  | { status: 'APPROVAL_PENDING'; firstDevice: boolean }

type StoreEnvelopeResponse = { status: 'TRUSTED' }

type FetchEnvelopeResponse = { status: string; wrappedCK: string }

type FetchCanaryResponse = { canaryIv: string; canaryCtext: string }

// =============================================================================
// Auth headers helper
// =============================================================================

const authHeaders = (): Record<string, string> => {
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
  httpClient: KyInstance,
  params: { deviceId: string; publicKey: string; name?: string },
): Promise<RegisterDeviceResponse> =>
  httpClient
    .post('devices', {
      json: params,
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<RegisterDeviceResponse>()

/** Store a wrapped content key (envelope) for a device. Optionally includes canary on first setup. */
export const storeEnvelope = async (
  httpClient: KyInstance,
  params: { deviceId: string; wrappedCK: string; canaryIv?: string; canaryCtext?: string },
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
export const fetchMyEnvelope = async (httpClient: KyInstance): Promise<FetchEnvelopeResponse> =>
  httpClient
    .get('devices/me/envelope', {
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<FetchEnvelopeResponse>()

/** Fetch the canary for recovery key verification. */
export const fetchCanary = async (httpClient: KyInstance): Promise<FetchCanaryResponse> =>
  httpClient
    .get('encryption/canary', {
      headers: authHeaders(),
      credentials: 'omit',
    })
    .json<FetchCanaryResponse>()
