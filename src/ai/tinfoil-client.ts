/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getUserCacheSecret } from '@/lib/auth-token'
import { getErrorName } from '@/lib/error-utils'
import { trackEvent } from '@/lib/posthog'
import { resolveAbsoluteBackendUrl } from '@/lib/url-utils'
import { getLocalSetting } from '@/stores/local-settings-store'
import type { Model } from '@/types'
import type { SecureClient } from 'tinfoil'
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
  enclave_fingerprint?: string
  router_endpoint?: string
}

type TinfoilTraceProperties = Pick<TinfoilAttestationProperties, 'trace_id' | 'engine' | 'provider' | 'model_id'>

type TinfoilClientLifecycleOptions = {
  createClient: (type: TinfoilClientType, cloudUrl: string, reporter: AttestationReporter) => Promise<SecureClient>
  getCloudUrl: () => string
  attestations?: AttestationStore
  trackAttestation?: (properties: TinfoilAttestationProperties) => void
}

type CachedTinfoilClient = {
  key: string
  clientPromise: Promise<SecureClient>
  reporter: AttestationReporter
}

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

/** Extract the verified enclave's identity so telemetry can date enclave-side changes. */
const getEnclaveIdentity = (client: SecureClient): Partial<TinfoilAttestationProperties> => {
  const document = client.getVerificationDocument()
  return {
    enclave_host: document.enclaveHost,
    release_digest: document.releaseDigest,
    enclave_fingerprint: document.enclaveFingerprint,
    router_endpoint: document.selectedRouterEndpoint,
  }
}

/** Observe the adapter's bounded readiness operation and emit structured telemetry. */
const waitForAttestation = async (
  client: SecureClient,
  clientType: TinfoilClientType,
  trackAttestation: (properties: TinfoilAttestationProperties) => void,
  traceProperties: TinfoilTraceProperties,
): Promise<TinfoilAttestationProperties> => {
  const startedAt = Date.now()

  try {
    await client.ready()
    return {
      outcome: 'success',
      duration_ms: Date.now() - startedAt,
      client: clientType,
      ...traceProperties,
      ...getEnclaveIdentity(client),
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
  const reportedClients = new WeakSet<SecureClient>()

  /** Resolve the cache key for a client type. */
  const getClientKey = (type: TinfoilClientType): string =>
    type === 'user' ? 'user' : `system:${getCloudUrl().replace(/\/$/, '')}`

  /** Cache construction before it settles so concurrent callers share one client. */
  const construct = (key: string, type: TinfoilClientType): CachedTinfoilClient => {
    const cloudUrl = type === 'system' ? key.slice('system:'.length) : ''
    const attestationKey = tinfoilAttestationKey(type, cloudUrl)
    attestationKeys.add(attestationKey)
    const owner = attestations.open(attestationKey)
    const reporter: AttestationReporter = {
      publish: (state) => {
        owner.publish(state)
        // A re-attestation can fail inside SDK fetch(), outside acquire().
        // Retire that cached generation immediately so the next send recovers.
        if (state.status === 'failed') {
          if (clients.get(key)?.reporter === reporter) {
            clients.delete(key)
          }
          owner.close()
        }
      },
      close: owner.close,
    }
    // Defer construction until its cache entry exists, including synchronous
    // provider failures reported before the factory's first await.
    const entry: CachedTinfoilClient = {
      key,
      clientPromise: Promise.resolve().then(async () => {
        const client = await createClient(type, cloudUrl, reporter)
        owners.set(client, entry)
        return client
      }),
      reporter,
    }
    clients.set(key, entry)
    return entry
  }

  /** Return an attested client, evicting failed construction or attestation. */
  const acquire = async (
    type: TinfoilClientType,
    traceProperties: TinfoilTraceProperties = {},
  ): Promise<SecureClient> => {
    const key = getClientKey(type)
    const entry = clients.get(key) ?? construct(key, type)
    try {
      const client = await entry.clientPromise
      const properties = await waitForAttestation(client, type, trackAttestation, traceProperties)
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
  const getSystemTinfoilClient = (traceProperties?: TinfoilTraceProperties): Promise<SecureClient> =>
    acquire('system', traceProperties)
  /** Return the attested user client. */
  const getTinfoilClient = (traceProperties?: TinfoilTraceProperties): Promise<SecureClient> =>
    acquire('user', traceProperties)
  /** Revoke a cached client's evidence before another generation can be acquired. */
  const evict = (type: TinfoilClientType, expectedClient?: object): void => {
    const expectedEntry = expectedClient ? owners.get(expectedClient) : undefined
    if (expectedClient && (!expectedEntry || clients.get(expectedEntry.key) !== expectedEntry)) {
      return
    }
    const key = expectedEntry?.key ?? getClientKey(type)
    clients.get(key)?.reporter.close()
    clients.delete(key)
    attestations.clear(`tinfoil:${key}`)
  }
  /** Drop the current cloud URL's system client. */
  const evictSystemTinfoilClient = (expectedClient?: object): void => evict('system', expectedClient)
  /** Drop the user client. */
  const evictUserTinfoilClient = (expectedClient?: object): void => evict('user', expectedClient)
  /** Revoke every identity-scoped client and snapshot, including failed generations. */
  const clearTinfoilClients = (): void => {
    clients.forEach(({ reporter }) => reporter.close())
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
  createClient: async (type, cloudUrl, reporter) => {
    const { AttestedTinfoilClient } = await import('@/attestation/tinfoil')
    if (type === 'user') {
      return new AttestedTinfoilClient({ userCacheSecret: getUserCacheSecret() }, reporter, tinfoilAttestationTimeoutMs)
    }
    return new AttestedTinfoilClient(
      {
        // SecureClient rejects a relative baseURL with a ConfigurationError.
        baseURL: `${resolveAbsoluteBackendUrl(cloudUrl)}/tinfoil`,
        userCacheSecret: getUserCacheSecret(),
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
