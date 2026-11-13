/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { withDeadline } from '@/lib/timeout'
import type { AttestationEvidence, AttestationReporter } from './types'

export type VerifiedTransport<T> = {
  value: T
  evidence: AttestationEvidence
  expiresAt: number
}

/** The vendor owns cryptographic verification; this contract owns its lifetime. */
export type AttestationTransport<T> = {
  provider: string
  baseURL: string
  verify: (signal: AbortSignal) => Promise<VerifiedTransport<T>>
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  close: () => void | Promise<void>
  isVerificationFailure: (error: unknown) => boolean
  normalizeFailure?: (error: unknown) => unknown
  isVerificationCurrent?: () => boolean
  reuseVerification?: boolean
  verifyAfterRequest?: boolean
}

/** Await shared verification without letting one cancelled request cancel other callers. */
export const withAttestationSignal = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const onAbort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Share evidence expiry, cancellation and failure handling across confidential providers. */
export class AttestedTransportClient<T> {
  private readonly lifetime = new AbortController()
  private verification: VerifiedTransport<T> | undefined
  private verifying: Promise<T> | undefined
  private expiration: ReturnType<typeof setTimeout> | undefined
  private failure: unknown
  readonly baseURL: string

  constructor(
    private readonly transport: AttestationTransport<T>,
    private readonly reporter: AttestationReporter,
    private readonly timeoutMs: number,
  ) {
    this.baseURL = transport.baseURL.replace(/\/$/, '')
  }

  /** Only return evidence while its verification and encrypted channel remain usable. */
  ensureVerified(): Promise<T> {
    if (this.lifetime.signal.aborted) {
      return Promise.reject(this.failure ?? this.lifetime.signal.reason)
    }
    try {
      if (this.verification && this.transport.isVerificationCurrent?.() === false) {
        this.invalidateVerification()
      }
    } catch (error) {
      return Promise.reject(this.fail(error))
    }
    if (this.transport.reuseVerification && this.verification && Date.now() < this.verification.expiresAt) {
      return Promise.resolve(this.verification.value)
    }
    this.verifying ??= this.verify()
    return this.verifying
  }

  /** Revoke evidence when a vendor rotates the deployment or encryption state internally. */
  invalidateVerification(): void {
    if (!this.verification || this.lifetime.signal.aborted) {
      return
    }
    this.verification = undefined
    clearTimeout(this.expiration)
    this.reporter.publish({ status: 'idle' })
  }

  private async verify(): Promise<T> {
    if (!this.verification || Date.now() >= this.verification.expiresAt) {
      this.reporter.publish({ status: 'verifying' })
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    try {
      const verification = await withDeadline(
        withAttestationSignal(this.transport.verify(signal), signal),
        this.timeoutMs,
        () => {
          const error = Object.assign(new Error(`${this.transport.provider} attestation timed out`), {
            name: `${this.transport.provider}AttestationTimeoutError`,
          })
          controller.abort(error)
          return error
        },
      )
      signal.throwIfAborted()
      if (!Number.isFinite(verification.expiresAt) || verification.expiresAt <= Date.now()) {
        throw new Error('The verified confidential connection has already expired')
      }
      if (verification.value !== this.verification?.value) {
        this.verification = verification
        this.reporter.publish({ status: 'verified', evidence: verification.evidence })
        clearTimeout(this.expiration)
        this.expiration = setTimeout(() => {
          this.verification = undefined
          this.reporter.publish({ status: 'idle' })
        }, verification.expiresAt - Date.now())
      }
      return verification.value
    } catch (error) {
      throw this.fail(error)
    } finally {
      this.verifying = undefined
    }
  }

  /** Bind inference and response consumption to the verified client's lifetime. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const callerSignal = init?.signal === undefined && input instanceof Request ? input.signal : init?.signal
    const signal = AbortSignal.any([this.lifetime.signal, ...(callerSignal ? [callerSignal] : [])])
    signal.throwIfAborted()
    await withAttestationSignal(this.ensureVerified(), signal)
    signal.throwIfAborted()
    try {
      const response = await this.request(input, init, signal)
      try {
        signal.throwIfAborted()
        if (this.transport.verifyAfterRequest) {
          await withAttestationSignal(this.ensureVerified(), signal)
        }
      } catch (error) {
        await response.body?.cancel().catch(() => {})
        throw error
      }
      return this.observeResponse(response, signal)
    } catch (error) {
      if (!signal.aborted && this.transport.isVerificationFailure(error)) {
        throw this.fail(error)
      }
      throw error
    }
  }

  /** Detach completed SDK requests; response-body cancellation owns their remaining stream lifetime. */
  private async request(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      signal.throwIfAborted()
      return await this.transport.fetch(input, { ...init, signal: controller.signal })
    } finally {
      // Some WASM SDKs release request callbacks on completion, so an identity
      // abort must not later invoke those callbacks on an already-finished call.
      signal.removeEventListener('abort', onAbort)
    }
  }

  private observeResponse(response: Response, signal: AbortSignal): Response {
    if (!response.body) {
      return response
    }
    const reader = response.body.getReader()
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const target = { controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined }
    const onAbort = () => {
      cleanup()
      target.controller?.error(signal.reason)
      void reader.cancel(signal.reason).catch(() => {})
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        target.controller = controller
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
        }
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read()
          if (signal.aborted) {
            return
          }
          if (chunk.done) {
            cleanup()
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
        } catch (error) {
          cleanup()
          controller.error(signal.aborted ? error : this.fail(error))
        }
      },
      async cancel(reason) {
        cleanup()
        await reader.cancel(reason)
      },
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  private fail(error: unknown): unknown {
    if (this.lifetime.signal.aborted) {
      return this.failure ?? error
    }
    this.failure = this.transport.normalizeFailure?.(error) ?? error
    this.reporter.publish({
      status: 'failed',
      reason: error instanceof Error && error.name.endsWith('AttestationTimeoutError') ? 'timeout' : 'verification',
    })
    void this.close()
    return this.failure
  }

  /** Immediately revoke evidence and pending results, then release vendor resources. */
  async close(): Promise<void> {
    if (this.lifetime.signal.aborted) {
      return
    }
    this.lifetime.abort(this.failure)
    clearTimeout(this.expiration)
    this.verification = undefined
    if (!this.failure) {
      this.reporter.publish({ status: 'idle' })
    }
    this.reporter.close()
    await this.transport.close()
  }
}
