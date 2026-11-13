/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PrivatemodeAI, type ExportedSecret, type VerifyResult } from 'privatemode-ai'
import wasmURL from 'privatemode-wasm?url'
import { AttestedTransportClient, withAttestationSignal } from './client'
import { asAttestationFailure } from './errors'
import type { AttestationEvidence, AttestationReporter } from './types'

export const privatemodeWasmHash = '395a8006a255b18862f7d9fbd1e0471b51ac6323efb42c7251398f9361593781'
const apiOrigin = 'https://api.privatemode.ai'
const baseURL = `${apiOrigin}/v1`
// The SDK exposes secret expiration, but no attestation freshness deadline.
const verificationLifetimeMs = 5 * 60 * 1_000

type RequestOptions = {
  method: 'get' | 'post'
  path: string
  body?: unknown
  signal: AbortSignal
  maxRetries: number
}

type SdkClient = Pick<PrivatemodeAI, 'verify' | 'refreshSecret' | 'exportSecret' | 'manifestBytes' | 'close'> & {
  request: (options: RequestOptions) => { asResponse: () => Promise<Response> }
}

/** Compare public manifest bytes without parsing or reserializing the signed policy. */
const sameManifest = (expected: Uint8Array, actual: Uint8Array | null): boolean =>
  actual !== null && expected.length === actual.length && expected.every((byte, index) => byte === actual[index])

/** Restore auth statuses the SDK's WASM initialization/refresh bridge serializes into plain errors. */
const normalizePrivatemodeFailure = (error: unknown): Error => {
  if (error instanceof Error) {
    const stage = error.message.match(
      /^(?:initializing client: offering credential to secret manager|updating secret: getting latest secret): setting secrets: /,
    )
    // Only these two credential-bearing HTTP requests qualify. Certificate,
    // manifest and OCSP failures can also contain 403 without rejecting a key.
    const rejected = stage
      ? error.message
          .slice(stage[0].length)
          .match(
            /(?:^|\n#\d+: )(?:updating mesh CA: doing attest request|doing request): (?:Unauthorized \(status code: (401)\)|unexpected status code: (403))(?:\n|$)/,
          )
      : null
    if (rejected) {
      return Object.assign(new Error('Privatemode rejected the API credential', { cause: error }), {
        name: 'PrivatemodeAuthenticationError',
        status: Number(rejected[1] ?? rejected[2]),
      })
    }
  }
  return asAttestationFailure(error)
}

/** Present the exact policy the SDK verified, without pretending it is a raw hardware quote. */
export const readPrivatemodeEvidence = async (
  verification: VerifyResult,
  manifestBytes: Uint8Array,
  verifiedAt: number,
): Promise<AttestationEvidence> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(manifestBytes))
  const manifestHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const policies = Object.entries(verification.manifest.Policies ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hash, policy]) => `${hash}: ${policy.SANs.join(', ')}`)
    .join('\n')
  return {
    provider: 'Privatemode',
    verifiedAt,
    endpoint: new URL(apiOrigin).host,
    checks: ['hardware', 'policy', 'channel'],
    details: [
      { label: 'manifest', value: manifestHash },
      ...(policies ? [{ label: 'policy' as const, value: policies }] : []),
    ],
  }
}

/** Limit the OpenAI bridge to SDK-supported endpoints on the configured confidential service. */
const requestPath = (request: Request): string | undefined => {
  const url = new URL(request.url)
  if (url.origin !== apiOrigin || url.username || url.password || url.search || url.hash) {
    return undefined
  }
  if (request.method === 'GET' && (url.pathname === '/v1/models' || /^\/v1\/models\/[^/]+$/.test(url.pathname))) {
    return url.pathname.slice('/v1'.length)
  }
  if (
    request.method === 'POST' &&
    ['/v1/chat/completions', '/v1/embeddings', '/v1/audio/transcriptions'].includes(url.pathname)
  ) {
    return url.pathname.slice('/v1'.length)
  }
  return undefined
}

/** Use OpenAI's public raw-response API, preserving the SDK's decrypted streaming bytes. */
export const createPrivatemodeFetch =
  (client: Pick<SdkClient, 'request'>) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const path = requestPath(request)
    if (!path) {
      return Response.json({ error: { message: 'Unsupported Privatemode endpoint' } }, { status: 400 })
    }
    const body =
      request.method === 'GET'
        ? undefined
        : path === '/audio/transcriptions'
          ? await request.formData()
          : await request.json()
    try {
      // Caller credentials and arbitrary headers must not escape through the vendor SDK.
      return await client
        .request({
          method: request.method === 'GET' ? 'get' : 'post',
          path,
          body,
          signal: request.signal,
          maxRetries: 0,
        })
        .asResponse()
    } catch (error) {
      if (error instanceof PrivatemodeAI.APIError && error.status) {
        const headers = new Headers(error.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')
        headers.set('content-type', 'application/json')
        return Response.json({ error: error.error ?? { message: error.message } }, { status: error.status, headers })
      }
      throw error
    }
  }

/** Adapt only vendor verification and transport; the shared client owns evidence and cancellation. */
export class AttestedPrivatemodeClient extends AttestedTransportClient<VerifyResult> {
  constructor(client: SdkClient, reporter: AttestationReporter, timeoutMs: number) {
    const state: { identity?: { manifest: Uint8Array; secretID: string; expiresAtUnix: number } } = {}
    super(
      {
        provider: 'Privatemode',
        baseURL,
        reuseVerification: true,
        verifyAfterRequest: true,
        isVerificationCurrent: () => {
          if (!state.identity) {
            return false
          }
          const secret = client.exportSecret()
          return (
            secret.id === state.identity.secretID &&
            secret.expiresAtUnix === state.identity.expiresAtUnix &&
            sameManifest(state.identity.manifest, client.manifestBytes)
          )
        },
        verify: async (signal) => {
          try {
            const result = await client.verify()
            signal.throwIfAborted()
            const verifiedManifest = client.manifestBytes
            if (!verifiedManifest) {
              throw new Error('Privatemode verification did not return its deployment manifest')
            }
            const manifest = new Uint8Array(verifiedManifest)
            await client.refreshSecret()
            signal.throwIfAborted()
            const verifiedAt = Date.now()
            const { id, expiresAtUnix }: Pick<ExportedSecret, 'id' | 'expiresAtUnix'> = client.exportSecret()
            if (!sameManifest(manifest, client.manifestBytes)) {
              throw new Error('Privatemode deployment changed while establishing encryption')
            }
            const evidence = await readPrivatemodeEvidence(result, manifest, verifiedAt)
            signal.throwIfAborted()
            state.identity = { manifest, secretID: id, expiresAtUnix }
            return {
              value: result,
              evidence,
              expiresAt: Math.min(expiresAtUnix * 1_000, verifiedAt + verificationLifetimeMs),
            }
          } catch (error) {
            // verify() has no abort parameter and can finish after logout or its deadline.
            if (signal.aborted) {
              client.close()
            }
            throw error
          }
        },
        fetch: createPrivatemodeFetch(client),
        close: () => client.close(),
        isVerificationFailure: () => true,
        normalizeFailure: normalizePrivatemodeFailure,
      },
      reporter,
      timeoutMs,
    )
  }

  /** Verify locally and establish encryption before exposing a transport to inference. */
  static async create(
    options: { apiKey: string; signal?: AbortSignal },
    reporter: AttestationReporter,
    timeoutMs: number,
  ): Promise<AttestedPrivatemodeClient> {
    options.signal?.throwIfAborted()
    const current: { client?: AttestedPrivatemodeClient } = {}
    const sdk = new PrivatemodeAI({
      apiKey: options.apiKey,
      apiBaseURL: apiOrigin,
      dangerouslyAllowBrowser: true,
      browserWasmURL: wasmURL,
      expectedWasmHash: privatemodeWasmHash,
      enableWasmLogging: false,
      nvidiaOCSPPolicy: { allowUnknown: false, revokedGracePeriodHours: 0 },
      openAIOptions: { maxRetries: 0 },
      onManifestUpdate: () => current.client?.invalidateVerification(),
      onSecretUpdate: () => current.client?.invalidateVerification(),
    })
    const client = new AttestedPrivatemodeClient(sdk, reporter, timeoutMs)
    current.client = client
    try {
      const pending = client.ensureVerified()
      if (options.signal) {
        await withAttestationSignal(pending, options.signal)
      } else {
        await pending
      }
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }
}
