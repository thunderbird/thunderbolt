/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { RecoveryKeyDialog } from '@/components/recovery-key-dialog'
import { useE2eeReady } from '@/hooks/use-e2ee-ready'
import { useChangeRecoveryKey } from './use-change-recovery-key'
import type { HttpClient } from '@/contexts'

type ChangeRecoveryKeySectionProps = {
  /** Dependency seam for the rotation (tests). Defaults to `changeRecoveryPhrase`. */
  rotate?: (httpClient: HttpClient) => Promise<string>
}

/**
 * "Change recovery phrase" row for the preferences Data section. Rotates the
 * Account Key (0 rows re-encrypted), re-anchors the recovery slot to a new
 * phrase, and shows those 24 words exactly once behind the saved-it
 * confirmation gate. This is the only place outside first-device setup and the
 * v1→v2 migration that mints a phrase — device revocation rotates silently.
 * Hidden until E2EE v2 is fully set up on this device — there is no key to
 * rotate before then.
 */
export const ChangeRecoveryKeySection = ({ rotate }: ChangeRecoveryKeySectionProps) => {
  const ready = useE2eeReady()
  const { status, isRotating, newRecoveryKey, error, openConfirm, cancel, confirmRotation, done } =
    useChangeRecoveryKey(rotate)

  if (!ready) {
    return null
  }

  return (
    <>
      <div className="h-px bg-border -mx-6" />

      <div className="flex flex-col gap-2">
        <label htmlFor="change-recovery-key-button" className="text-sm font-medium">
          Change Recovery Phrase
        </label>
        <p className="text-sm text-muted-foreground">
          Generate a new 24-word recovery phrase for your encrypted data. Your current phrase will stop working.
        </p>
        <Button id="change-recovery-key-button" variant="secondary" onClick={openConfirm}>
          Change Recovery Phrase
        </Button>
      </div>

      <AlertDialog open={status === 'confirming'} onOpenChange={(open) => !open && !isRotating && cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change your recovery phrase?</AlertDialogTitle>
            <AlertDialogDescription>
              A new 24-word recovery phrase will be generated and shown to you once. Your current phrase will stop
              working immediately. Your synced data is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            {/* Radix's Cancel closes the dialog itself; a plain Button for the
                confirm keeps the dialog open while the rotation is in flight
                (and doubles as the retry affordance on failure). */}
            <AlertDialogCancel disabled={isRotating}>Cancel</AlertDialogCancel>
            <Button onClick={confirmRotation} isLoading={isRotating} loadingLabel="Generating…">
              {error ? 'Try again' : 'Generate new phrase'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RecoveryKeyDialog
        open={status === 'display'}
        recoveryKey={newRecoveryKey ?? ''}
        title="Save your new recovery phrase"
        description="Your old recovery phrase no longer works. Write down these 24 words in order and store them somewhere safe. This phrase won't be shown again."
        onDone={done}
      />
    </>
  )
}
