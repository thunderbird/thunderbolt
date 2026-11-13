/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getUserCacheSecret } from '@/lib/auth-token'
import { getErrorName } from '@/lib/error-utils'
import { trackEvent } from '@/lib/posthog'
import { resolveAbsoluteBackendUrl } from '@/lib/url-utils'
import { getLocalSetting } from '@/stores/local-settings-store'
import { createAttestedClientCache } from '@/attestation/client-cache'
import type { AttestedTinfoilClient, TinfoilVerification } from '@/attestation/tinfoil'
import { attestationStore, type AttestationStore } from '@/attestation/store'
import { tinfoilAttestationKey } from '@/attestation/target'
import type { AttestationReporter } from '@/attestation/types'

export const tinfoilAttestationTimeoutMs = 15_000

type TinfoilClientType = 'system' | 'user'
type TinfoilAttestationProperties = {
  outcome: 'success' | 'error' | 'timeout'
  duration_ms: number
  error_name?: string
  client: TinfoilClientType
  trace_id?: string
  engine?: 'pi'
  provider?: string
  model_id?: string
  enclave_host?: string
  release_digest?: string
  /** V3's structured measurement as JSON; distinct from the retired v1 fingerprint series. */
  enclave_measurement?: string
}

type TinfoilTraceProperties = Pick<TinfoilAttestationProperties, 'trace_id' | 'engine' | 'provider' | 'model_id'>

type TinfoilClientLifecycleOptions = {
  createClient: (
    type: TinfoilClientType,
    cloudUrl: string,
    reporter: AttestationReporter,
    signal: AbortSignal,
  ) => Promise<AttestedTinfoilClient>
  getCloudUrl: () => string
  attestations?: AttestationStore
  trackAttestation?: (properties: TinfoilAttestationProperties) => void
}

/** Keep app error classification stable while preserving SDK causes for telemetry. */
const createAttestationError = (cause: unknown): Error => {
  const causeName = getErrorName(cause) ?? 'Error'
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  return Object.assign(new Error(`Tinfoil attestation failed: ${causeName}: ${causeMessage}`, { cause }), {
    name: 'TinfoilAttestationError',
  })
}

/** Extract the verified enclave's identity so telemetry can date enclave-side changes. */
const getEnclaveIdentity = (
  client: AttestedTinfoilClient,
  verification: TinfoilVerification,
): Partial<TinfoilAttestationProperties> => ({
  enclave_host: client.enclave,
  release_digest: verification.codeDigest,
  enclave_measurement: JSON.stringify(verification.toJSON().enclaveMeasurement),
})

/** Observe the adapter's bounded readiness operation and emit structured telemetry. */
const waitForAttestation = async (
  pending: Promise<AttestedTinfoilClient>,
  clientType: TinfoilClientType,
  trackAttestation: (properties: TinfoilAttestationProperties) => void,
  traceProperties: TinfoilTraceProperties,
  signal: AbortSignal,
): Promise<{ client: AttestedTinfoilClient; properties: TinfoilAttestationProperties }> => {
  const startedAt = Date.now()

  try {
    const client = await pending
    signal.throwIfAborted()
    const verification = await client.ensureVerified()
    signal.throwIfAborted()
    return {
      client,
      properties: {
        outcome: 'success',
        duration_ms: Date.now() - startedAt,
        client: clientType,
        ...traceProperties,
        ...getEnclaveIdentity(client, verification),
      },
    }
  } catch (error) {
    signal.throwIfAborted()
    if (!isTinfoilAttestationFailure(error)) {
      throw error
    }
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
 * inject client factories and telemetry without shared-module mocks.
 */
export const createTinfoilClientLifecycle = ({
  createClient,
  getCloudUrl,
  attestations = attestationStore,
  trackAttestation = (properties) => trackEvent('tinfoil_attestation', properties),
}: TinfoilClientLifecycleOptions) => {
  const reportedClients = new WeakSet<AttestedTinfoilClient>()
  type Request = { type: TinfoilClientType; cloudUrl: string }
  const cache = createAttestedClientCache<Request, AttestedTinfoilClient>({
    key: ({ type, cloudUrl }) => tinfoilAttestationKey(type, cloudUrl),
    create: ({ type, cloudUrl }, reporter, signal) => createClient(type, cloudUrl, reporter, signal),
    attestations,
  })
  const request = (type: TinfoilClientType): Request => ({
    type,
    cloudUrl: type === 'system' ? getCloudUrl().replace(/\/$/, '') : '',
  })
  const acquire = (type: TinfoilClientType, traceProperties: TinfoilTraceProperties = {}) =>
    cache.acquire(request(type), async (pending, signal) => {
      const { client, properties } = await waitForAttestation(pending, type, trackAttestation, traceProperties, signal)
      signal.throwIfAborted()
      if (!reportedClients.has(client) || traceProperties.trace_id !== undefined) {
        reportedClients.add(client)
        trackAttestation(properties)
      }
      return client
    })
  return {
    getSystemTinfoilClient: (traceProperties?: TinfoilTraceProperties) => acquire('system', traceProperties),
    getTinfoilClient: (traceProperties?: TinfoilTraceProperties) => acquire('user', traceProperties),
    evictSystemTinfoilClient: (expectedClient?: object) => cache.evict(request('system'), expectedClient),
    evictUserTinfoilClient: (expectedClient?: object) => cache.evict(request('user'), expectedClient),
    clearTinfoilClients: cache.clear,
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
  createClient: async (type, cloudUrl, reporter, signal) => {
    const { AttestedTinfoilClient } = await import('@/attestation/tinfoil')
    if (type === 'user') {
      return AttestedTinfoilClient.create(
        { userCacheSecret: getUserCacheSecret(), signal },
        reporter,
        tinfoilAttestationTimeoutMs,
      )
    }
    return AttestedTinfoilClient.create(
      {
        // AttestedTinfoilClient rejects a relative baseURL with a ConfigurationError.
        baseURL: `${resolveAbsoluteBackendUrl(cloudUrl)}/tinfoil`,
        userCacheSecret: getUserCacheSecret(),
        signal,
      },
      reporter,
      tinfoilAttestationTimeoutMs,
    )
  },
  getCloudUrl: () => getLocalSetting('cloudUrl'),
})

export const {
  getSystemTinfoilClient,
  evictSystemTinfoilClient,
  getTinfoilClient,
  evictUserTinfoilClient,
  clearTinfoilClients,
} = lifecycle

/** Match v2's classified trust failures; the SDK itself owns safe key-rotation replay. */
export const isTinfoilAttestationFailure = (error: unknown): boolean =>
  getErrorName(error) === 'TinfoilAttestationError' ||
  getErrorName(error) === 'TinfoilAttestationTimeoutError' ||
  (typeof error === 'object' && error !== null && 'category' in error && error.category === 'attestation')
