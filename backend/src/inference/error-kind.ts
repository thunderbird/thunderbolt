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

const contextLengthIdentifiers = new Set([
  'context_length_error',
  'context_length_exceeded',
  'max_tokens_exceeded',
  'token_limit_exceeded',
])
const schemaValidationIdentifiers = new Set([
  'invalid_schema',
  'json_schema_validation_error',
  'schema_validation_error',
  'tool_schema_error',
])
const rateLimitIdentifiers = new Set(['rate_limit_error', 'rate_limit_exceeded', 'too_many_requests'])
const authIdentifiers = new Set(['authentication_error', 'invalid_api_key', 'permission_denied', 'unauthorized'])
const badRequestIdentifiers = new Set(['bad_request', 'invalid_request', 'invalid_request_error'])

/** Maps an inference HTTP status to its body-free telemetry category when recognized. */
export const errorKindFromStatus = (status: number): InferenceErrorKind | undefined => {
  if (status === 401 || status === 403) {
    return 'auth'
  }
  if (status === 429) {
    return 'rate_limit'
  }
  if (status >= 500) {
    return 'upstream_error'
  }
  if (status === 400 || status === 422) {
    return 'bad_request'
  }
  return undefined
}

/** Classifies an inference failure into a fixed, body-free telemetry category. */
export const classifyInferenceError = (error: unknown): InferenceErrorKind => {
  if (error instanceof APIConnectionError) {
    return 'connection'
  }

  const errorCode = error instanceof APIError ? error.code?.toLowerCase() : undefined
  const errorType = error instanceof APIError ? error.type?.toLowerCase() : undefined
  const identifiers = [errorCode, errorType]

  if (identifiers.some((identifier) => identifier && contextLengthIdentifiers.has(identifier))) {
    return 'context_length'
  }
  if (identifiers.some((identifier) => identifier && schemaValidationIdentifiers.has(identifier))) {
    return 'schema_validation'
  }
  if (identifiers.some((identifier) => identifier && rateLimitIdentifiers.has(identifier))) {
    return 'rate_limit'
  }
  if (identifiers.some((identifier) => identifier && authIdentifiers.has(identifier))) {
    return 'auth'
  }

  const status = error instanceof APIError ? error.status : undefined
  const statusErrorKind = status === undefined ? undefined : errorKindFromStatus(status)
  if (statusErrorKind !== undefined && statusErrorKind !== 'bad_request') {
    return statusErrorKind
  }

  const message = error instanceof Error ? error.message : ''
  if (
    /\b(context (?:length|window)|maximum context|max(?:imum)? tokens?|too many tokens?|token limit|prompt is too long)\b/i.test(
      message,
    )
  ) {
    return 'context_length'
  }
  if (/\b(invalid (?:json )?schema|schema validation|tool schema|function schema|required property)\b/i.test(message)) {
    return 'schema_validation'
  }
  if (/\b(rate limit|too many requests|quota exceeded)\b/i.test(message)) {
    return 'rate_limit'
  }
  if (/\b(unauthorized|authentication|invalid api key|permission denied|forbidden)\b/i.test(message)) {
    return 'auth'
  }
  if (/\b(connection error|connection refused|network error|request timed out|timeout)\b/i.test(message)) {
    return 'connection'
  }
  if (identifiers.some((identifier) => identifier && badRequestIdentifiers.has(identifier))) {
    return 'bad_request'
  }
  if (statusErrorKind === 'bad_request' || /\b(bad request|invalid request)\b/i.test(message)) {
    return 'bad_request'
  }
  return 'unknown'
}
