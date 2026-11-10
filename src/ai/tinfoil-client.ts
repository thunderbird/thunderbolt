/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getUserCacheSecret } from '@/lib/auth-token'
import { getErrorName } from '@/lib/error-utils'
import { trackEvent } from '@/lib/posthog'
import { resolveAbsoluteBackendUrl } from '@/lib/url-utils'
import { getLocalSetting } from '@/stores/local-settings-store'
import { getIdentitySignal } from '@/lib/identity-lifetime'
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

type CachedTinfoilClient = {
  key: string
  clientPromise: Promise<AttestedTinfoilClient>
  reporter: AttestationReporter
  controller: AbortController
  detachIdentity: () => void
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
  const clients = new Map<string, CachedTinfoilClient>()
  const owners = new WeakMap<object, CachedTinfoilClient>()
  const attestationKeys = new Set<string>()
  const reportedClients = new WeakSet<AttestedTinfoilClient>()

  /** Release resources even when a failed factory returns its client late. */
  const release = (entry: CachedTinfoilClient): void => {
    entry.detachIdentity()
    entry.reporter.close()
    void entry.clientPromise.then(
      (client) => client.close(),
      () => {},
    )
  }

  /** Explicit teardown cancels acquisitions without classifying them as trust failures. */
  const cancel = (entry: CachedTinfoilClient): void => {
    entry.controller.abort()
    release(entry)
  }

  /** Resolve the cache key for a client type. */
  const getClientKey = (type: TinfoilClientType): string =>
    type === 'user' ? 'user' : `system:${getCloudUrl().replace(/\/$/, '')}`

  /** Cache construction before it settles so concurrent callers share one client. */
  const construct = (key: string, type: TinfoilClientType): CachedTinfoilClient => {
    const cloudUrl = type === 'system' ? key.slice('system:'.length) : ''
    const attestationKey = tinfoilAttestationKey(type, cloudUrl)
    attestationKeys.add(attestationKey)
    const owner = attestations.open(attestationKey)
    const controller = new AbortController()
    const identity = getIdentitySignal()
    const retireIdentity = () => {
      if (clients.get(key) === entry) {
        clients.delete(key)
        attestations.clear(attestationKey)
      }
      cancel(entry)
    }
    const reporter: AttestationReporter = {
      publish: (state) => {
        owner.publish(state)
        // A re-attestation can fail inside SDK fetch(), outside acquire().
        // Retire that cached generation immediately so the next send recovers.
        if (state.status === 'failed') {
          if (clients.get(key)?.reporter === reporter) {
            clients.delete(key)
          }
          release(entry)
        }
      },
      close: owner.close,
    }
    // Defer construction until its cache entry exists, including synchronous
    // provider failures reported before the factory's first await.
    const entry: CachedTinfoilClient = {
      key,
      clientPromise: Promise.resolve().then(async () => {
        const client = await createClient(type, cloudUrl, reporter, controller.signal)
        owners.set(client, entry)
        return client
      }),
      reporter,
      controller,
      detachIdentity: () => identity.removeEventListener('abort', retireIdentity),
    }
    clients.set(key, entry)
    identity.addEventListener('abort', retireIdentity, { once: true })
    return entry
  }

  /** Return an attested client, evicting failed construction or attestation. */
  const acquire = async (
    type: TinfoilClientType,
    traceProperties: TinfoilTraceProperties = {},
  ): Promise<AttestedTinfoilClient> => {
    const key = getClientKey(type)
    const entry = clients.get(key) ?? construct(key, type)
    try {
      const { client, properties } = await waitForAttestation(
        entry.clientPromise,
        type,
        trackAttestation,
        traceProperties,
        entry.controller.signal,
      )
      entry.controller.signal.throwIfAborted()
      if (clients.get(key) !== entry) {
        throw createAttestationError(new Error('This Tinfoil client was revoked during verification.'))
      }
      if (!reportedClients.has(client) || traceProperties.trace_id !== undefined) {
        reportedClients.add(client)
        trackAttestation(properties)
      }
      return client
    } catch (error) {
      // Delete only the failed generation; a replacement may already be cached.
      if (clients.get(key) === entry) {
        entry.reporter.publish({
          status: 'failed',
          reason: getErrorName(error) === 'TinfoilAttestationTimeoutError' ? 'timeout' : 'verification',
        })
      }
      throw error
    }
  }

  /** Return the attested system client for the current cloud URL. */
  const getSystemTinfoilClient = (traceProperties?: TinfoilTraceProperties): Promise<AttestedTinfoilClient> =>
    acquire('system', traceProperties)
  /** Return the attested user client. */
  const getTinfoilClient = (traceProperties?: TinfoilTraceProperties): Promise<AttestedTinfoilClient> =>
    acquire('user', traceProperties)
  /** Revoke a cached client's evidence before another generation can be acquired. */
  const evict = (type: TinfoilClientType, expectedClient?: object): void => {
    const expectedEntry = expectedClient ? owners.get(expectedClient) : undefined
    if (expectedClient && (!expectedEntry || clients.get(expectedEntry.key) !== expectedEntry)) {
      return
    }
    const key = expectedEntry?.key ?? getClientKey(type)
    const entry = clients.get(key)
    if (entry) {
      cancel(entry)
    }
    clients.delete(key)
    attestations.clear(`tinfoil:${key}`)
  }
  /** Drop the current cloud URL's system client. */
  const evictSystemTinfoilClient = (expectedClient?: object): void => evict('system', expectedClient)
  /** Drop the user client. */
  const evictUserTinfoilClient = (expectedClient?: object): void => evict('user', expectedClient)
  /** Revoke every identity-scoped client and snapshot, including failed generations. */
  const clearTinfoilClients = (): void => {
    clients.forEach(cancel)
    clients.clear()
    attestationKeys.forEach((key) => attestations.clear(key))
    attestationKeys.clear()
  }

  return {
    getSystemTinfoilClient,
    evictSystemTinfoilClient,
    getTinfoilClient,
    evictUserTinfoilClient,
    clearTinfoilClients,
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
