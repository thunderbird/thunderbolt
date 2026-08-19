/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RecoveryKeyDialog } from '@/components/recovery-key-dialog'
import { useRecoveryPhrasePending } from '@/lib/recovery-phrase-pending'
import { useChangeRecoveryKey } from '@/settings/encryption/use-change-recovery-key'

/**
 * Re-prompt for an account whose recovery phrase was minted but never
 * acknowledged — the app was reloaded, crashed or force-quit while the phrase
 * was on screen, or (before this existed) the migration dialog was suppressed.
 *
 * The original phrase cannot be re-shown: `AK = PBKDF2(seed, salt)` is one-way
 * and the seed was never persisted. So the only honest remedy is to mint a fresh
 * one, which is exactly what the existing "Change recovery phrase" rotation
 * does — reused here rather than duplicated.
 *
 * Dismissible per session (the user may be mid-task and their data is safe while
 * this device holds its keys), but the flag survives, so it returns on the next
 * launch until a phrase is actually confirmed.
 */
export const UnsavedRecoveryPhrasePrompt = () => {
  const pending = useRecoveryPhrasePending()
  const [dismissed, setDismissed] = useState(false)
  const { status, newRecoveryKey, isRotating, error, confirmRotation, done } = useChangeRecoveryKey()

  if (!pending && status !== 'display') {
    return null
  }

  return (
    <>
      <AlertDialog open={pending && !dismissed && status !== 'display'}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Your recovery phrase was never saved</AlertDialogTitle>
            <AlertDialogDescription>
              Encryption is set up on this device, but the 24-word recovery phrase was not confirmed. Without it you
              cannot recover your data if you lose access to this device. The previous phrase cannot be shown again —
              generate a new one now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDismissed(true)} disabled={isRotating}>
              Later
            </Button>
            <AlertDialogAction onClick={confirmRotation} disabled={isRotating}>
              {isRotating ? 'Generating…' : 'Generate a new phrase'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RecoveryKeyDialog
        open={status === 'display'}
        recoveryKey={newRecoveryKey ?? ''}
        title="Save your new recovery phrase"
        description="Write down these 24 words in order and store them somewhere safe. This phrase won't be shown again."
        onDone={done}
      />
    </>
  )
}
