/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createClient } from '@/lib/http'
import { StepUpVerificationError } from '@/lib/step-up'
import { AccountManagedByIdpError, deleteAccount, postAccountDeletionCode } from './account'

/** A client whose every request is answered with `status` and the JSON `body`. */
const clientAnswering = (status: number, body: unknown) =>
  createClient({
    prefixUrl: 'http://backend.test',
    fetch: async () => Response.json(body, { status }),
  })

const idpManaged = { error: 'Your organization manages this account', code: 'ACCOUNT_IDP_MANAGED' }

describe('account deletion API', () => {
  it('reports an IdP-managed account on the code request and on the delete', async () => {
    const client = clientAnswering(403, idpManaged)
    await expect(postAccountDeletionCode(client)).rejects.toBeInstanceOf(AccountManagedByIdpError)
    await expect(deleteAccount(client, { stepUpOtp: '12345678' })).rejects.toBeInstanceOf(AccountManagedByIdpError)
  })

  it('still reports a step-up refusal on the delete', async () => {
    const client = clientAnswering(403, { code: 'step_up_invalid' })
    await expect(deleteAccount(client, { stepUpOtp: '12345678' })).rejects.toBeInstanceOf(StepUpVerificationError)
  })
})
