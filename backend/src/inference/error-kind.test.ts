/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { APIConnectionError, APIError } from 'openai'
import { classifyInferenceError, errorKindFromStatus, type InferenceErrorKind } from './error-kind'

/** Creates an SDK error with provider-style structured metadata. */
const createApiError = (status: number, code?: string, type?: string, message?: string) =>
  new APIError(status, { code, type, message }, undefined, new Headers())

describe('classifyInferenceError', () => {
  const cases: Array<{ expected: InferenceErrorKind; error: unknown }> = [
    {
      expected: 'context_length',
      error: createApiError(400, 'context_length_exceeded', 'invalid_request_error'),
    },
    {
      expected: 'schema_validation',
      error: createApiError(400, 'invalid_schema', 'invalid_request_error'),
    },
    { expected: 'rate_limit', error: createApiError(400, 'rate_limit_exceeded') },
    { expected: 'rate_limit', error: createApiError(400, 'rate_limit_error') },
    { expected: 'auth', error: createApiError(400, 'authentication_error') },
    { expected: 'auth', error: createApiError(400, 'invalid_api_key') },
    { expected: 'bad_request', error: createApiError(400, undefined, 'invalid_request_error') },
    { expected: 'connection', error: new APIConnectionError({ message: 'provider unavailable' }) },
    { expected: 'upstream_error', error: createApiError(503) },
    { expected: 'unknown', error: new Error('provider returned an unexpected response') },
  ]

  for (const { expected, error } of cases) {
    it(`classifies ${expected}`, () => {
      expect(classifyInferenceError(error)).toBe(expected)
    })
  }

  it('classifies the Anthropic prompt-too-long message as context_length', () => {
    expect(
      classifyInferenceError(
        createApiError(400, undefined, 'invalid_request_error', 'prompt is too long: 215000 tokens > 200000 maximum'),
      ),
    ).toBe('context_length')
  })
})

describe('errorKindFromStatus', () => {
  const cases: Array<{ expected: InferenceErrorKind; status: number }> = [
    { expected: 'auth', status: 401 },
    { expected: 'auth', status: 403 },
    { expected: 'rate_limit', status: 429 },
    { expected: 'upstream_error', status: 500 },
    { expected: 'upstream_error', status: 599 },
    { expected: 'bad_request', status: 400 },
    { expected: 'bad_request', status: 422 },
    { expected: 'bad_request', status: 404 },
    { expected: 'bad_request', status: 409 },
  ]

  for (const { expected, status } of cases) {
    it(`maps ${status} to ${expected}`, () => {
      expect(errorKindFromStatus(status)).toBe(expected)
    })
  }
})
