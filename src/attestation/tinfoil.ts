/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EnclaveHTTPClient, RouterHTTPClient, type RouterOptions } from 'tinfoil'
import { getErrorName } from '@/lib/error-utils'
import { withDeadline } from '@/lib/timeout'
import type { AttestationEvidence, AttestationReporter } from './types'
import { AttestedTransportClient } from './client'

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
export class AttestedTinfoilClient extends AttestedTransportClient<TinfoilVerification> {
  readonly enclave: string

  constructor(
    client: HttpClient,
    reporter: AttestationReporter,
    timeoutMs: number,
    baseURL = client.baseURL.replace(/\/$/, ''),
  ) {
    super(
      {
        provider: 'Tinfoil',
        baseURL,
        verify: async (signal) => {
          const verification = await client.ensureVerified({ signal })
          return {
            value: verification,
            evidence: readTinfoilEvidence(verification, client.enclave),
            expiresAt: verification.freshnessExpiresAt!.getTime(),
          }
        },
        fetch: (input, init) => client.fetch(input, init),
        close: () => client.close(),
        isVerificationFailure: (error) =>
          typeof error === 'object' && error !== null && 'category' in error && error.category === 'attestation',
        verifyAfterRequest: true,
      },
      reporter,
      timeoutMs,
    )
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
}

/** Keep timeout classification stable across SDK releases. */
const attestationTimeout = (timeoutMs: number): Error =>
  Object.assign(new Error(`Tinfoil attestation timed out after ${timeoutMs}ms`), {
    name: 'TinfoilAttestationTimeoutError',
  })

/** The UI distinguishes a bounded wait from rejected verification without exposing vendor details. */
const failureReason = (error: unknown) =>
  getErrorName(error) === 'TinfoilAttestationTimeoutError' ? ('timeout' as const) : ('verification' as const)
