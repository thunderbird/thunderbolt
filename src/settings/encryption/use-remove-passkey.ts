/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetchEncryptionMetadata } from '@/api/encryption'
import { useAuth, useHttpClient } from '@/contexts'
import { useE2eeReady } from '@/hooks/use-e2ee-ready'
import { i18n } from '@/i18n'
import { HttpError } from '@/lib/http'
import { accountPasskeyQueryKey, deletePasskey, type PasskeyRecord } from '@/lib/passkey'
import { removePasskeySlot } from '@/services/encryption'
import { msg } from '@lingui/core/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

type RemoveStatus = 'idle' | 'confirming' | 'removing'

/** Whether the account's passkey slot belongs to `passkey`. A 404 means sync was never set up. */
const holdsSyncSlot = async (
  httpClient: ReturnType<typeof useHttpClient>,
  passkey: PasskeyRecord,
): Promise<boolean> => {
  try {
    const metadata = await fetchEncryptionMetadata(httpClient)
    return metadata.passkey_credential_id === passkey.credentialID
  } catch (err) {
    if (err instanceof HttpError && err.response.status === 404) {
      return false
    }
    throw err
  }
}

type RemoveSteps = {
  holdsSyncSlot: () => Promise<boolean>
  removeSyncSlot: () => Promise<void>
  deletePasskey: () => Promise<unknown>
  /** Whether this device holds the keys an AK rotation needs. */
  e2eeReady: boolean
}

/**
 * The removal sequence, in its only safe order: drop the sync slot (an AK
 * rotation) BEFORE deleting the passkey. Deleting first would leave a slot that
 * still opens the AK with no passkey row left to show or remove it.
 */
export const removeAccountPasskey = async ({
  holdsSyncSlot: hasSlot,
  removeSyncSlot,
  deletePasskey: deleteRow,
  e2eeReady,
}: RemoveSteps): Promise<'removed' | 'needs-sync'> => {
  if (await hasSlot()) {
    if (!e2eeReady) {
      return 'needs-sync'
    }
    await removeSyncSlot()
  }
  await deleteRow()
  return 'removed'
}

/**
 * Remove the account's passkey. When it holds the sync slot, the slot goes first
 * (an AK rotation, so the passkey can no longer unlock the new AK) and the passkey
 * second — the server refuses the reverse order. The rotation needs this device's
 * keys, so a device without sync set up can only remove a passkey that holds no slot.
 */
export const useRemovePasskey = (passkey: PasskeyRecord) => {
  const authClient = useAuth()
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()
  const e2eeReady = useE2eeReady()
  const [status, setStatus] = useState<RemoveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setStatus('removing')
    setError(null)
    try {
      const outcome = await removeAccountPasskey({
        holdsSyncSlot: () => holdsSyncSlot(httpClient, passkey),
        removeSyncSlot: () => removePasskeySlot(httpClient),
        deletePasskey: () => deletePasskey(authClient, passkey.id),
        e2eeReady,
      })
      if (outcome === 'needs-sync') {
        setError(i18n._(msg`Turn on sync on this device to remove this passkey.`))
        setStatus('confirming')
        return
      }
      await queryClient.invalidateQueries({ queryKey: accountPasskeyQueryKey })
      setStatus('idle')
    } catch (err) {
      console.error('Failed to remove passkey:', err)
      setError(i18n._(msg`Couldn't remove the passkey. Please try again.`))
      setStatus('confirming')
    }
  }

  return {
    status,
    error,
    openConfirm: () => {
      setError(null)
      setStatus('confirming')
    },
    cancel: () => setStatus('idle'),
    remove,
  }
}
