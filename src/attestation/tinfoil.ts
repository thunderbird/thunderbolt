/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EnclaveHTTPClient, RouterHTTPClient, type RouterOptions } from 'tinfoil'
import { getErrorName } from '@/lib/error-utils'
import { withDeadline } from '@/lib/timeout'
import type { AttestationEvidence, AttestationReporter } from './types'

export type TinfoilVerification = Awaited<ReturnType<RouterHTTPClient['ensureVerified']>>
type HttpClient = Pick<RouterHTTPClient, 'fetch' | 'baseURL' | 'enclave' | 'ensureVerified' | 'close'>
type Options = RouterOptions & { enclave?: { host: string; repo: string } }

/** Format only the public registers attested by the verifier, without channel keys. */
export const tinfoilMeasurement = (verification: TinfoilVerification): string => {
  const { platform, ...registers } = verification.toJSON().enclaveMeasurement
  return [platform, ...Object.entries(registers).map(([register, value]) => `${register}: ${value}`)].join('\n')
}

/** Translate a currently valid SDK verification, after its transport has bound the verified keys. */
export const readTinfoilEvidence = (verification: TinfoilVerification, enclave: string): AttestationEvidence => ({
  provider: 'Tinfoil',
  verifiedAt: verification.metadata.verifiedAt.getTime(),
  endpoint: enclave,
  checks: ['hardware', 'code', 'measurement', 'channel'],
  details: [
    { label: 'source', value: verification.configRepo },
    { label: 'release', value: verification.codeDigest },
    { label: 'measurement', value: tinfoilMeasurement(verification) },
  ],
})

/** Keep vendor crypto and retry logic in the SDK while owning UI evidence and the client's lifetime. */
export class AttestedTinfoilClient {
  private readonly lifetime = new AbortController()
  private verification: TinfoilVerification | undefined
  private verifying: Promise<TinfoilVerification> | undefined
  private expiration: ReturnType<typeof setTimeout> | undefined
  private failure: unknown
  readonly baseURL: string
  readonly enclave: string

  constructor(
    private readonly client: HttpClient,
    private readonly reporter: AttestationReporter,
    private readonly timeoutMs: number,
    baseURL = client.baseURL.replace(/\/$/, ''),
  ) {
    this.baseURL = baseURL
    this.enclave = client.enclave
  }

  /** Creates a verified SDK client, explicitly retaining sealed HTTP bodies on every platform. */
  static async create(
    options: Options,
    reporter: AttestationReporter,
    timeoutMs: number,
  ): Promise<AttestedTinfoilClient> {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
    const settings: RouterOptions = {
      ...options,
      transportMode: 'ehbp',
      signal,
      verificationCheck: async (verification) => {
        signal.throwIfAborted()
        // This callback precedes transport key binding. It cannot publish verified evidence.
        reporter.publish({ status: 'verifying' })
        await options.verificationCheck?.(verification)
      },
    }
    reporter.publish({ status: 'verifying' })
    const pending: Promise<HttpClient> = options.enclave
      ? EnclaveHTTPClient.create(options.enclave.host, options.enclave.repo, settings)
      : RouterHTTPClient.create(settings)
    try {
      const client = await withDeadline(pending, timeoutMs, () => {
        const error = attestationTimeout(timeoutMs)
        controller.abort(error)
        return error
      })
      signal.throwIfAborted()
      const baseURL = options.baseURL ?? (options.enclave ? client.baseURL : new URL('v1/', client.baseURL).href)
      const observed = new AttestedTinfoilClient(client, reporter, timeoutMs, baseURL.replace(/\/$/, ''))
      await observed.ensureVerified()
      return observed
    } catch (error) {
      controller.abort(error)
      reporter.publish({ status: 'failed', reason: failureReason(error) })
      reporter.close()
      // A factory may finish after its deadline; release that otherwise-unowned transport.
      void pending.then(
        (client) => client.close(),
        () => {},
      )
      throw error
    }
  }

  /** Reuses the SDK's checked cache; expired or rejected evidence is verified again with a bounded wait. */
  ensureVerified(): Promise<TinfoilVerification> {
    if (this.lifetime.signal.aborted) {
      return Promise.reject(this.failure ?? this.lifetime.signal.reason)
    }
    this.verifying ??= this.verify()
    return this.verifying
  }

  private async verify(): Promise<TinfoilVerification> {
    if (!this.verification || Date.now() >= this.verification.freshnessExpiresAt!.getTime()) {
      this.reporter.publish({ status: 'verifying' })
    }
    const controller = new AbortController()
    try {
      const verification = await withDeadline(
        this.client.ensureVerified({ signal: AbortSignal.any([controller.signal, this.lifetime.signal]) }),
        this.timeoutMs,
        () => {
          const error = attestationTimeout(this.timeoutMs)
          controller.abort(error)
          return error
        },
      )
      this.lifetime.signal.throwIfAborted()
      if (verification !== this.verification) {
        this.verification = verification
        this.reporter.publish({ status: 'verified', evidence: readTinfoilEvidence(verification, this.enclave) })
        clearTimeout(this.expiration)
        this.expiration = setTimeout(
          () => {
            this.verification = undefined
            this.reporter.publish({ status: 'idle' })
          },
          Math.max(0, verification.freshnessExpiresAt!.getTime() - Date.now()),
        )
      }
      return verification
    } catch (error) {
      this.fail(error)
      throw error
    } finally {
      this.verifying = undefined
    }
  }

  /** The SDK owns key-rejection replay; a failed attestation retires this client before another request. */
  readonly fetch: HttpClient['fetch'] = async (input, init) => {
    const callerSignal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal
    const signal = AbortSignal.any([this.lifetime.signal, ...(callerSignal ? [callerSignal] : [])])
    signal.throwIfAborted()
    await this.ensureVerified()
    signal.throwIfAborted()
    try {
      const response = await this.client.fetch(input, { ...init, signal })
      // Fetch may have rotated the enclave's keys internally. Read checked evidence, never current.
      try {
        await this.ensureVerified()
      } catch (error) {
        await response.body?.cancel().catch(() => {})
        throw error
      }
      return response
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'category' in error && error.category === 'attestation') {
        this.fail(error)
      }
      throw error
    }
  }

  private fail(error: unknown): void {
    this.failure = error
    this.reporter.publish({ status: 'failed', reason: failureReason(error) })
    void this.close()
  }

  /** Revoke evidence immediately and release the SDK's resources, including after eviction or logout. */
  async close(): Promise<void> {
    this.lifetime.abort()
    clearTimeout(this.expiration)
    this.verification = undefined
    if (!this.failure) {
      this.reporter.publish({ status: 'idle' })
    }
    this.reporter.close()
    await this.client.close()
  }
}

/** Keep timeout classification stable across SDK releases. */
const attestationTimeout = (timeoutMs: number): Error =>
  Object.assign(new Error(`Tinfoil attestation timed out after ${timeoutMs}ms`), {
    name: 'TinfoilAttestationTimeoutError',
  })

/** The UI distinguishes a bounded wait from rejected verification without exposing vendor details. */
const failureReason = (error: unknown) =>
  getErrorName(error) === 'TinfoilAttestationTimeoutError' ? ('timeout' as const) : ('verification' as const)
