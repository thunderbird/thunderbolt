/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpError } from '@/lib/http'

export type StepUpRefusalCode = 'step_up_required' | 'step_up_invalid'

/**
 * Thrown when a gated route refuses an action for want of a valid step-up code.
 * `step_up_required`: no code accompanied the request. `step_up_invalid`: the
 * code was wrong, expired, or burned its attempt budget — the server answers
 * all three identically on purpose.
 */
export class StepUpVerificationError extends Error {
  code: StepUpRefusalCode
  constructor(code: StepUpRefusalCode, options?: ErrorOptions) {
    super(`Refused by step-up gate: ${code}`, options)
    this.name = 'StepUpVerificationError'
    this.code = code
  }
}

/**
 * The server's step-up refusal code, or null if this error is not one. Shared
 * so each gated action decodes the 403 the same way.
 */
export const stepUpRefusalCode = async (err: unknown): Promise<StepUpRefusalCode | null> => {
  if (!(err instanceof HttpError) || err.response.status !== 403) {
    return null
  }
  const body = (await err.response.json().catch(() => null)) as { code?: string } | null
  return body?.code === 'step_up_required' || body?.code === 'step_up_invalid' ? body.code : null
}
