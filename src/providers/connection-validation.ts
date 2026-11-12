/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { withAttestationSignal } from '@/attestation/client'
import { classifyErrorKind, getErrorName } from '@/lib/error-utils'
import { HttpError } from '@/lib/http'
import type { ProviderType } from './types'

export type ConnectionValidationFailure = 'credentials' | 'attestation' | 'timeout' | 'connection'

/** Expose actionable validation categories without displaying vendor responses or credentials. */
export class ProviderConnectionValidationError extends Error {
  readonly kind: ConnectionValidationFailure

  constructor(kind: ConnectionValidationFailure, cause?: unknown) {
    super('Provider connection validation failed', { cause })
    this.name = 'ProviderConnectionValidationError'
    this.kind = kind
  }
}

type CredentialValidation = { apiKey: string; signal: AbortSignal }

const validators: Partial<Record<ProviderType, (options: CredentialValidation) => Promise<void>>> = {
  privatemode: async ({ apiKey, signal }) => {
    const { validatePrivatemodeApiKey } = await import('@/ai/privatemode-client')
    signal.throwIfAborted()
    await validatePrivatemodeApiKey(apiKey, signal)
  },
}

/** Accept structured SDK and HTTP status codes, leaving vendor text interpretation to its adapter. */
const validationStatus = (error: Error): number | undefined => {
  if (error instanceof HttpError) {
    return error.response.status
  }
  if ('status' in error && typeof error.status === 'number') {
    return error.status
  }
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode
  }
  return undefined
}

/** Inspect preserved causes, including authentication failures wrapped by attestation adapters. */
const validationFailure = (error: unknown): ConnectionValidationFailure => {
  const chain: Error[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = current.cause
  }
  if (
    chain.some((cause) => {
      const status = validationStatus(cause)
      return status === 401 || status === 403
    })
  ) {
    return 'credentials'
  }
  if (chain.some((cause) => getErrorName(cause)?.includes('Timeout') || classifyErrorKind(cause) === 'timeout')) {
    return 'timeout'
  }
  if (chain.some((cause) => classifyErrorKind(cause) === 'network' || validationStatus(cause) !== undefined)) {
    return 'connection'
  }
  return chain.some((cause) => classifyErrorKind(cause) === 'attestation') ? 'attestation' : 'connection'
}

/** Run only provider-specific credential proofs; a public model catalog is not a general API-key check. */
export const validateProviderConnectionCredentials = async ({
  provider,
  apiKey,
  signal,
}: CredentialValidation & { provider: ProviderType }): Promise<void> => {
  signal.throwIfAborted()
  const validate = validators[provider]
  if (!validate) {
    return
  }
  const operation = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  try {
    await withAttestationSignal(validate({ apiKey, signal: operation }), operation)
    operation.throwIfAborted()
  } catch (error) {
    signal.throwIfAborted()
    throw new ProviderConnectionValidationError(validationFailure(operation.aborted ? operation.reason : error), error)
  }
}
