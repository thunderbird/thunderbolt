/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { HttpError } from '@/lib/http'
import { StepUpVerificationError, stepUpRefusalCode } from '@/lib/step-up'

/** Thrown when the user's organization manages the account through its identity provider, which alone removes it. */
export class AccountManagedByIdpError extends Error {
  constructor(options?: ErrorOptions) {
    super('The account is managed by an identity provider', options)
    this.name = 'AccountManagedByIdpError'
  }
}

/** Rethrow the server's refusal to delete an IdP-managed account as `AccountManagedByIdpError`. */
const throwIfManagedByIdp = async (err: unknown) => {
  if (!(err instanceof HttpError) || err.response.status !== 403) {
    return
  }
  // A clone: the step-up check reads the same body afterwards.
  const body = (await err.response
    .clone()
    .json()
    .catch(() => null)) as { code?: string } | null
  if (body?.code === 'ACCOUNT_IDP_MANAGED') {
    throw new AccountManagedByIdpError({ cause: err })
  }
}

/**
 * Ask the server to email a step-up code for account deletion. The server picks
 * the address from the session; the code is spent by the next `deleteAccount`.
 * Throws `AccountManagedByIdpError` for an IdP-managed account.
 */
export const postAccountDeletionCode = async (httpClient: HttpClient): Promise<void> => {
  try {
    await httpClient.post('account/deletion/step-up/request')
  } catch (err) {
    await throwIfManagedByIdp(err)
    throw err
  }
}

/**
 * Permanently delete the account. Throws `StepUpVerificationError` when the
 * code is missing, wrong, expired, or out of attempts — the server answers
 * those identically — and `AccountManagedByIdpError` for an IdP-managed account.
 */
export const deleteAccount = async (httpClient: HttpClient, opts: { stepUpOtp: string }): Promise<void> => {
  try {
    await httpClient.delete('account', { json: { stepUpOtp: opts.stepUpOtp } })
  } catch (err) {
    await throwIfManagedByIdp(err)
    const refusal = await stepUpRefusalCode(err)
    if (refusal) {
      throw new StepUpVerificationError(refusal, { cause: err })
    }
    throw err
  }
}
