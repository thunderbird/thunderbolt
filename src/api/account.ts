/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { StepUpVerificationError, stepUpRefusalCode } from '@/lib/step-up'

/**
 * Ask the server to email a step-up code for account deletion. The server picks
 * the address from the session; the code is spent by the next `deleteAccount`.
 */
export const postAccountDeletionCode = async (httpClient: HttpClient): Promise<void> => {
  await httpClient.post('account/deletion/step-up/request')
}

/**
 * Permanently delete the account. Throws `StepUpVerificationError` when the
 * code is missing, wrong, expired, or out of attempts — the server answers
 * those identically.
 */
export const deleteAccount = async (httpClient: HttpClient, opts: { stepUpOtp: string }): Promise<void> => {
  try {
    await httpClient.delete('account', { json: { stepUpOtp: opts.stepUpOtp } })
  } catch (err) {
    const refusal = await stepUpRefusalCode(err)
    if (refusal) {
      throw new StepUpVerificationError(refusal, { cause: err })
    }
    throw err
  }
}
