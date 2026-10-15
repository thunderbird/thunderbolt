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
import { type PasskeyRecord } from '@/lib/passkey'
import { Trans, useLingui } from '@lingui/react/macro'
import { AddPasskeyDialog } from './add-passkey-dialog'
import { usePasskeySectionState } from './use-passkey-section-state'
import { useRemovePasskey } from './use-remove-passkey'

/**
 * "Passkey" row for the preferences Data section, below the sync toggle. The
 * account has at most one passkey: this row shows and removes it, or adds one
 * when there is none. Hidden while passkeys are unavailable.
 */
export const PasskeySection = () => {
  const { row, isAddDialogOpen, setIsAddDialogOpen, unlocksSync, openAddDialog } = usePasskeySectionState()

  return (
    <>
      {row.kind === 'passkey' && <PasskeyRow passkey={row.passkey} />}
      {row.kind === 'add' && <AddPasskeyRow onAdd={openAddDialog} />}
      {/* Outside the rows: enrolling swaps or hides them, and must keep its dialog. */}
      <AddPasskeyDialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen} unlocksSync={unlocksSync} />
    </>
  )
}

const AddPasskeyRow = ({ onAdd }: { onAdd: () => void }) => (
  <>
    <div className="h-px bg-border -mx-6" />

    <div className="flex flex-row items-center justify-between gap-4">
      <div className="min-w-0">
        <label className="text-sm font-medium">
          <Trans>Passkey</Trans>
        </label>
        <p className="text-sm text-muted-foreground">
          <Trans>Sign in with your fingerprint, face, or device PIN.</Trans>
        </p>
      </div>
      <Button variant="secondary" onClick={onAdd}>
        <Trans>Add</Trans>
      </Button>
    </div>
  </>
)

const PasskeyRow = ({ passkey }: { passkey: PasskeyRecord }) => {
  const { t } = useLingui()
  const { status, error, openConfirm, cancel, remove } = useRemovePasskey(passkey)
  const isBusy = status === 'removing'

  return (
    <>
      <div className="h-px bg-border -mx-6" />

      <div className="flex flex-row items-center justify-between gap-4">
        <div className="min-w-0">
          <label className="text-sm font-medium">
            <Trans>Passkey</Trans>
          </label>
          <p className="truncate text-sm text-muted-foreground">{passkey.name || t`Passkey`}</p>
        </div>
        <Button variant="secondary" onClick={openConfirm}>
          <Trans>Remove</Trans>
        </Button>
      </div>

      <AlertDialog open={status === 'confirming' || isBusy} onOpenChange={(open) => !open && !isBusy && cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Remove your passkey?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                You won&apos;t be able to sign in or unlock sync with this passkey anymore. Devices that are already set
                up keep working.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <Button variant="destructive" onClick={remove} isLoading={isBusy}>
              <Trans>Remove</Trans>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
