/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SecureClient, type VerificationDocument } from 'tinfoil'
import { getErrorName } from '@/lib/error-utils'
import { withDeadline } from '@/lib/timeout'
import type { AttestationEvidence, AttestationReporter } from './types'

/** Translate successful SDK evidence without copying secrets or vendor types into UI state. */
export const readTinfoilEvidence = (document: VerificationDocument): AttestationEvidence => {
  const steps = document.steps
  if (
    !document.securityVerified ||
    [steps.fetchDigest, steps.verifyCode, steps.verifyEnclave, steps.compareMeasurements, steps.verifyCertificate].some(
      (step) => step?.status !== 'success',
    ) ||
    steps.otherError?.status === 'failed' ||
    !document.enclaveHost ||
    !document.releaseDigest ||
    !document.enclaveFingerprint
  ) {
    throw Object.assign(new Error('Tinfoil verification evidence is incomplete.'), { name: 'TinfoilAttestationError' })
  }
  return {
    provider: 'Tinfoil',
    verifiedAt: Date.now(),
    endpoint: document.enclaveHost,
    checks: ['hardware', 'code', 'measurement', 'channel'],
    details: [
      { label: 'source', value: document.configRepo },
      { label: 'release', value: document.releaseDigest },
      { label: 'measurement', value: document.enclaveFingerprint },
    ],
  }
}

/**
 * Observe the SDK's public lifecycle, including ready/reset calls made internally
 * during key rotation. All encryption and cryptographic verification stay in the SDK.
 * Loaded lazily with Tinfoil so the UI never pulls crypto into the entry bundle.
 */
export class AttestedTinfoilClient extends SecureClient {
  private verifiedDocument: VerificationDocument | undefined
  private readiness: Promise<void> | undefined
  private failure: { error: unknown } | undefined

  constructor(
    options: ConstructorParameters<typeof SecureClient>[0],
    private readonly reporter: AttestationReporter,
    private readonly timeoutMs: number,
  ) {
    super(options)
  }

  override ready(): Promise<void> {
    if (this.failure) {
      return Promise.reject(this.failure.error)
    }
    if (this.verifiedDocument === this.getVerificationDocument()) {
      return Promise.resolve()
    }
    this.readiness ??= this.verify()
    return this.readiness
  }

  /** Share one deadline across callers; a failed SDK instance must never carry another request. */
  private async verify(): Promise<void> {
    this.reporter.publish({ status: 'verifying' })
    try {
      await withDeadline(super.ready(), this.timeoutMs, () =>
        Object.assign(new Error(`Tinfoil attestation timed out after ${this.timeoutMs}ms`), {
          name: 'TinfoilAttestationTimeoutError',
        }),
      )
      if (this.failure) {
        throw this.failure.error
      }
      const document = this.getVerificationDocument()
      const evidence = readTinfoilEvidence(document)
      this.verifiedDocument = document
      this.reporter.publish({ status: 'verified', evidence })
    } catch (error) {
      this.failure = { error }
      this.verifiedDocument = undefined
      this.reporter.publish({
        status: 'failed',
        reason: getErrorName(error) === 'TinfoilAttestationTimeoutError' ? 'timeout' : 'verification',
      })
      throw error
    } finally {
      this.readiness = undefined
    }
  }

  override reset(): void {
    super.reset()
    this.verifiedDocument = undefined
    // SDK initialization cannot be aborted and can still overwrite its own
    // transport after reset. Retire this instance instead of starting a second
    // initialization on it; the lifecycle will construct a fresh SDK instance.
    if (this.readiness) {
      this.failure = {
        error: Object.assign(new Error('Tinfoil verification was reset before it completed.'), {
          name: 'TinfoilAttestationError',
        }),
      }
      this.reporter.publish({ status: 'failed', reason: 'verification' })
      return
    }
    if (!this.failure) {
      this.reporter.publish({ status: 'idle' })
    }
  }
}
