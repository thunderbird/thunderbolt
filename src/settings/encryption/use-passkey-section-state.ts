/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isE2eeReady } from '@/hooks/use-e2ee-ready'
import { useAccountPasskey, usePasskeyAvailable, type PasskeyRecord } from '@/lib/passkey'
import { useState } from 'react'

/** Which Preferences row to show: none, the account's passkey, or the Add row. */
type PasskeyRow = { kind: 'hidden' } | { kind: 'passkey'; passkey: PasskeyRecord } | { kind: 'add' }

/**
 * State for the Preferences passkey section: which row to show, and the Add
 * dialog with whether its passkey should also unlock sync.
 */
export const usePasskeySectionState = () => {
  const passkeyAvailable = usePasskeyAvailable()
  const { passkey, isLoading, isError } = useAccountPasskey()
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [unlocksSync, setUnlocksSync] = useState(false)

  // Read at the tap rather than from `useE2eeReady`, which is false until its
  // first read lands: an early tap would create a passkey that can't unlock sync.
  // An unreadable key store counts as no sync keys, as it does there.
  const openAddDialog = async () => {
    setUnlocksSync(await isE2eeReady().catch(() => false))
    setIsAddDialogOpen(true)
  }

  const getRow = (): PasskeyRow => {
    // A failed lookup isn't "no passkey": offering Add would collide with the one
    // the account may have.
    if (!passkeyAvailable || isLoading || isError) {
      return { kind: 'hidden' }
    }
    return passkey ? { kind: 'passkey', passkey } : { kind: 'add' }
  }

  return { row: getRow(), isAddDialogOpen, setIsAddDialogOpen, unlocksSync, openAddDialog }
}
