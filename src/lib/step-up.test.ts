/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { HttpError } from '@/lib/http'
import { StepUpVerificationError, stepUpRefusalCode } from '@/lib/step-up'

const httpError = (status: number, body?: unknown) =>
  new HttpError(
    new Response(body === undefined ? 'not json' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

describe('stepUpRefusalCode', () => {
  it('reads both refusal codes off a 403', async () => {
    expect(await stepUpRefusalCode(httpError(403, { code: 'step_up_required' }))).toBe('step_up_required')
    expect(await stepUpRefusalCode(httpError(403, { code: 'step_up_invalid' }))).toBe('step_up_invalid')
  })

  // A 403 the gate did not produce — the account routes answer one for
  // anonymous accounts, and it must not be mistaken for a bad code.
  it('ignores a 403 carrying some other code', async () => {
    expect(await stepUpRefusalCode(httpError(403, { code: 'anonymous_account' }))).toBeNull()
    expect(await stepUpRefusalCode(httpError(403, { error: 'nope' }))).toBeNull()
  })

  it('ignores a 403 whose body is not JSON', async () => {
    expect(await stepUpRefusalCode(httpError(403))).toBeNull()
  })

  it('ignores other statuses, even with a refusal code in the body', async () => {
    expect(await stepUpRefusalCode(httpError(409, { code: 'step_up_invalid' }))).toBeNull()
    expect(await stepUpRefusalCode(httpError(429, { code: 'step_up_required' }))).toBeNull()
  })

  it('ignores anything that is not an HttpError', async () => {
    expect(await stepUpRefusalCode(new Error('boom'))).toBeNull()
    expect(await stepUpRefusalCode(null)).toBeNull()
  })
})

describe('StepUpVerificationError', () => {
  it('carries the refusal code', () => {
    const err = new StepUpVerificationError('step_up_invalid')
    expect(err.code).toBe('step_up_invalid')
    expect(err.name).toBe('StepUpVerificationError')
    expect(err).toBeInstanceOf(Error)
  })
})
