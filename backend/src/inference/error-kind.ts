/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { APIConnectionError, APIError } from 'openai'

export type InferenceErrorKind =
  | 'context_length'
  | 'schema_validation'
  | 'rate_limit'
  | 'auth'
  | 'bad_request'
  | 'connection'
  | 'upstream_error'
  | 'unknown'

const providerErrorKinds: Record<string, InferenceErrorKind> = {
  context_length_exceeded: 'context_length',
  invalid_schema: 'schema_validation',
  rate_limit_exceeded: 'rate_limit',
  rate_limit_error: 'rate_limit',
  authentication_error: 'auth',
  invalid_api_key: 'auth',
}

/** Maps an inference HTTP status to its body-free telemetry category. */
export const errorKindFromStatus = (status: number): InferenceErrorKind => {
  if (status === 401 || status === 403) {
    return 'auth'
  }
  if (status === 429) {
    return 'rate_limit'
  }
  if (status >= 500) {
    return 'upstream_error'
  }
  return 'bad_request'
}

/** Classifies an inference failure into a fixed, body-free telemetry category. */
export const classifyInferenceError = (error: unknown): InferenceErrorKind => {
  if (error instanceof APIConnectionError) {
    return 'connection'
  }

  if (!(error instanceof APIError)) {
    return 'unknown'
  }

  const codeKind = error.code ? providerErrorKinds[error.code.toLowerCase()] : undefined
  if (codeKind) {
    return codeKind
  }

  if (
    /\b(context (?:length|window)|maximum context|max(?:imum)? tokens?|too many tokens?|token limit|prompt is too long)\b/i.test(
      error.message,
    )
  ) {
    return 'context_length'
  }

  return errorKindFromStatus(error.status)
}
