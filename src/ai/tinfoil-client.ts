/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getUserCacheSecret } from '@/lib/auth-token'
import { getErrorName } from '@/lib/error-utils'
import { trackEvent } from '@/lib/posthog'
import { withDeadline } from '@/lib/timeout'
import { getLocalSetting } from '@/stores/local-settings-store'
import type { Model } from '@/types'
import type { SecureClient } from 'tinfoil'

export const tinfoilAttestationTimeoutMs = 15_000

type TinfoilClientType = 'system' | 'user'
type TinfoilAttestationProperties = {
  outcome: 'success' | 'error' | 'timeout'
  duration_ms: number
  error_name?: string
  client: TinfoilClientType
  trace_id?: string
  engine?: 'pi' | 'legacy'
  provider?: string
  model_id?: string
}

type TinfoilTraceProperties = Pick<TinfoilAttestationProperties, 'trace_id' | 'engine' | 'provider' | 'model_id'>

type TinfoilClientLifecycleOptions = {
  createClient: (type: TinfoilClientType, cloudUrl: string) => Promise<SecureClient>
  getCloudUrl: () => string
  timeoutMs?: number
  trackAttestation?: (properties: TinfoilAttestationProperties) => void
}

/** Create the timeout error surfaced when Tinfoil attestation does not settle. */
const createAttestationTimeoutError = (timeoutMs: number): Error =>
  Object.assign(new Error(`Tinfoil attestation timed out after ${timeoutMs}ms`), {
    name: 'TinfoilAttestationTimeoutError',
  })

/**
 * Stabilize attestation classification across the SDK's inconsistent failure
 * names; live malformed and unreachable ATC responses use SyntaxError/TypeError.
 */
const createAttestationError = (cause: unknown): Error => {
  const causeName = getErrorName(cause) ?? 'Error'
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  return Object.assign(new Error(`Tinfoil attestation failed: ${causeName}: ${causeMessage}`, { cause }), {
    name: 'TinfoilAttestationError',
  })
}

/** Bound the SDK's non-abortable attestation wait and emit structured telemetry. */
const waitForAttestation = async (
  client: SecureClient,
  clientType: TinfoilClientType,
  timeoutMs: number,
  trackAttestation: (properties: TinfoilAttestationProperties) => void,
  traceProperties: TinfoilTraceProperties,
): Promise<TinfoilAttestationProperties> => {
  const startedAt = Date.now()

  try {
    // Escaped FetchError resets SDK state, so next ready() re-attests against
    // atc.tinfoil.sh; bound every call, including previously attested clients.
    await withDeadline(client.ready(), timeoutMs, () => createAttestationTimeoutError(timeoutMs))
    return {
      outcome: 'success',
      duration_ms: Date.now() - startedAt,
      client: clientType,
      ...traceProperties,
    }
  } catch (error) {
    const isTimeout = getErrorName(error) === 'TinfoilAttestationTimeoutError'
    trackAttestation({
      outcome: isTimeout ? 'timeout' : 'error',
      duration_ms: Date.now() - startedAt,
      error_name: getErrorName(error),
      client: clientType,
      ...traceProperties,
    })
    // Wrap only at the throw so telemetry reports the underlying SDK failure
    // name while classification keys on our stable wrapper name.
    throw isTimeout ? error : createAttestationError(error)
  }
}

/**
 * Create an isolated Tinfoil lifecycle. Production uses one instance; tests
 * inject client factories, timeout, and telemetry without shared-module mocks.
 */
export const createTinfoilClientLifecycle = ({
  createClient,
  getCloudUrl,
  timeoutMs = tinfoilAttestationTimeoutMs,
  trackAttestation = (properties) => trackEvent('tinfoil_attestation', properties),
}: TinfoilClientLifecycleOptions) => {
  const clients = new Map<string, Promise<SecureClient>>()
  const reportedClients = new WeakSet<SecureClient>()

  /** Resolve the cache key for a client type. */
  const getClientKey = (type: TinfoilClientType): string =>
    type === 'user' ? 'user' : `system:${getCloudUrl().replace(/\/$/, '')}`

  /** Cache construction before it settles so concurrent callers share one client. */
  const construct = (key: string, type: TinfoilClientType): Promise<SecureClient> => {
    const cloudUrl = type === 'system' ? key.slice('system:'.length) : ''
    const clientPromise = createClient(type, cloudUrl)
    clients.set(key, clientPromise)
    return clientPromise
  }

  /** Return an attested client, evicting failed construction or attestation. */
  const acquire = async (
    type: TinfoilClientType,
    traceProperties: TinfoilTraceProperties = {},
  ): Promise<SecureClient> => {
    const key = getClientKey(type)
    const clientPromise = clients.get(key) ?? construct(key, type)
    try {
      const client = await clientPromise
      const properties = await waitForAttestation(client, type, timeoutMs, trackAttestation, traceProperties)
      if (!reportedClients.has(client) || traceProperties.trace_id !== undefined) {
        reportedClients.add(client)
        trackAttestation(properties)
      }
      return client
    } catch (error) {
      // Delete only the failed generation; a replacement may already be cached.
      if (clients.get(key) === clientPromise) {
        clients.delete(key)
      }
      throw error
    }
  }

  /** Return the attested system client for the current cloud URL. */
  const getSystemTinfoilClient = (traceProperties?: TinfoilTraceProperties): Promise<SecureClient> =>
    acquire('system', traceProperties)
  /** Return the attested user client. */
  const getTinfoilClient = (traceProperties?: TinfoilTraceProperties): Promise<SecureClient> =>
    acquire('user', traceProperties)
  /** Drop the current cloud URL's system client. */
  const evictSystemTinfoilClient = (): void => {
    clients.delete(getClientKey('system'))
  }
  /** Drop the user client. */
  const evictUserTinfoilClient = (): void => {
    clients.delete(getClientKey('user'))
  }

  return {
    getSystemTinfoilClient,
    evictSystemTinfoilClient,
    getTinfoilClient,
    evictUserTinfoilClient,
  }
}

// Cached so callers reuse one client and its SDK-managed attestation state.
// `tinfoil` is dynamically imported to code-split its attestation/crypto deps.
//
// system: HPKE body POSTs to <cloudUrl>/tinfoil; backend injects our key.
// user:   BYOK — direct to the enclave with the user's own key.
//
// System cache is keyed by cloudUrl so a dev-tools URL switch hits the new
// backend on the next call.
const lifecycle = createTinfoilClientLifecycle({
  // Cache construction synchronously before this dynamic import resolves so
  // prewarm and immediate first send share one client and attestation.
  createClient: async (type, cloudUrl) => {
    const { SecureClient } = await import('tinfoil')
    if (type === 'user') {
      return new SecureClient({ userCacheSecret: getUserCacheSecret() })
    }
    return new SecureClient({ baseURL: `${cloudUrl}/tinfoil`, userCacheSecret: getUserCacheSecret() })
  },
  getCloudUrl: () => getLocalSetting('cloudUrl'),
})

export const { getSystemTinfoilClient, evictSystemTinfoilClient, getTinfoilClient, evictUserTinfoilClient } = lifecycle

/**
 * Best-effort warm-up of the Tinfoil system enclave so first chat send avoids
 * attestation on its critical path. Errors surface on real sends.
 */
export const runSystemModelPrewarm = async (model: Pick<Model, 'provider' | 'isSystem'> | null | undefined) => {
  if (!model || model.provider !== 'tinfoil' || !model.isSystem) {
    return
  }
  try {
    await getSystemTinfoilClient()
  } catch (error) {
    console.warn('runSystemModelPrewarm: warm-up skipped', error)
  }
}

/**
 * Match transport failures that require replacing the cached SecureClient.
 * Message matching is brittle but unavoidable: SDK concurrent reset race
 * exposes only a generic TypeError, with no exported class or discriminator.
 */
export const isTinfoilTransportWedgedError = (error: unknown): boolean => {
  const errorName = getErrorName(error)
  if (errorName === 'KeyConfigMismatchError') {
    return true
  }
  return (
    errorName === 'TypeError' &&
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes("reading 'fetch'")
  )
}
