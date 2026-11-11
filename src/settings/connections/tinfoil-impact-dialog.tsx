/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type Props = {
  action: 'disable' | 'disconnect'
  open: boolean
  pending: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}

/** Confirms loss of the account's models and search before changing the connection. */
export const TinfoilImpactDialog = ({ action, open, pending, error, onCancel, onConfirm }: Props) => (
  <AlertDialog
    open={open}
    onOpenChange={(next) => {
      if (!next && !pending) {
        onCancel()
      }
    }}
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {action === 'disable' ? <Trans>Disable Tinfoil?</Trans> : <Trans>Disconnect Tinfoil?</Trans>}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {action === 'disable' ? (
            <Trans>
              This will disable the models and Exa search provided by this Tinfoil connection. You can enable it again
              without signing in.
            </Trans>
          ) : (
            <Trans>
              This will disconnect your Tinfoil account and disable the models and Exa search provided by this
              connection. You’ll need to reconnect to use them again.
            </Trans>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={pending}
          onClick={(event) => {
            event.preventDefault()
            onConfirm()
          }}
        >
          {pending ? (
            <Trans>Please wait…</Trans>
          ) : action === 'disable' ? (
            <Trans>Disable Tinfoil</Trans>
          ) : (
            <Trans>Disconnect Tinfoil</Trans>
          )}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
