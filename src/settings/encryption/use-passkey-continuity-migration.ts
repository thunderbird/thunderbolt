/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useHttpClient } from '@/contexts'
import { useAsyncAttempt } from '@/hooks/use-async-attempt'
import { i18n } from '@/i18n'
import { getPasskeyPrfOutput, isPasskeyCancellation } from '@/lib/passkey'
import {
  migratePasskeyContinuity,
  PasskeyContinuityUnsupportedError,
  PasskeyMismatchError,
  UnverifiedAccountKeyError,
} from '@/services/encryption'

export type PasskeyMigrationError = 'cancelled' | 'noPrf' | 'mismatch' | 'unsupported' | 'unverified' | 'failed'

const errorMessages = {
  cancelled: msg`The passkey check was cancelled. Try again when you're ready.`,
  noPrf: msg`This passkey can't unlock encrypted data. Remove it and add another passkey.`,
  mismatch: msg`This passkey doesn't match the one saved for sync. Remove it and add it again.`,
  unsupported: msg`Passkey updates aren't available yet. Try again later.`,
  unverified: msg`This device can't add or update a passkey because its encryption keys couldn't be verified. Do it from a device that was trusted before.`,
  failed: msg`Couldn't update the passkey. Try again.`,
} satisfies Record<PasskeyMigrationError, MessageDescriptor>

const classify = (err: Error): PasskeyMigrationError => {
  if (isPasskeyCancellation(err)) {
    return 'cancelled'
  }
  if (err instanceof PasskeyMismatchError) {
    return 'mismatch'
  }
  if (err instanceof PasskeyContinuityUnsupportedError) {
    return 'unsupported'
  }
  return err instanceof UnverifiedAccountKeyError ? 'unverified' : 'failed'
}

/**
 * "Update passkey": check the slot's passkey with a real PRF ceremony, then seal
 * the slot in one rotation (`migratePasskeyContinuity`). A cancelled or failed
 * ceremony writes nothing; the next `run` starts over. Never retries by itself.
 */
export const usePasskeyContinuityMigration = (
  migrate: typeof migratePasskeyContinuity = migratePasskeyContinuity,
  readPrf: (credentialId: string) => Promise<Uint8Array | null> = getPasskeyPrfOutput,
) => {
  const httpClient = useHttpClient()
  const operation = useAsyncAttempt()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PasskeyMigrationError | null>(null)

  /**
   * One migration at a time. The credential lookup (a fresh status read) runs
   * inside the guard, so a second tap during it starts no second prompt.
   * Resolves null when nothing ran, when the lookup finds nothing to migrate,
   * or on failure, which `error` reports.
   */
  const run = async (lookupCredentialId: () => Promise<string | null>): Promise<'sealed' | 'alreadySealed' | null> => {
    const attempt = operation.begin()
    if (!attempt) {
      return null
    }
    setBusy(true)
    setError(null)
    try {
      const credentialId = await lookupCredentialId()
      if (!credentialId) {
        return null
      }
      const prfOutput = await readPrf(credentialId)
      if (!prfOutput) {
        setError('noPrf')
        return null
      }
      return await migrate(httpClient, { credentialId, prfOutput })
    } catch (err) {
      setError(err instanceof Error ? classify(err) : 'failed')
      return null
    } finally {
      setBusy(false)
      attempt.finish()
    }
  }

  return { busy, error, errorMessage: error ? i18n._(errorMessages[error]) : null, run }
}
