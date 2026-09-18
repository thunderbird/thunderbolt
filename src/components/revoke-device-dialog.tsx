/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type RevokeDeviceDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  isPending: boolean
  variant: 'trusted' | 'pending' | 'cli'
  /**
   * Rendered above the footer when the last attempt failed. The dialog stays
   * OPEN on failure so this sits next to the button that retries it — see the
   * confirm control below.
   */
  error?: string | null
  /** Optional action beside the error, e.g. "Change recovery phrase". */
  errorAction?: ReactNode
}

/**
 * The `trusted` copy must not promise remote erasure. Revocation cuts the
 * device's server access; the data already on its disk is untouched, and that
 * device's own "Device access revoked" modal asks whether to keep or delete the
 * local copy — defaulting to KEEP (`revoked-device-modal.tsx`). Saying otherwise
 * is not just inconsistent: someone revoking a lost or stolen device would
 * believe its contents were wiped when they were not.
 */
/**
 * The `trusted` copy must not promise remote erasure. Revocation cuts the
 * device's server access; the data already on its disk is untouched, and that
 * device's own "Device access revoked" modal asks whether to keep or delete the
 * local copy — defaulting to KEEP (`revoked-device-modal.tsx`). Saying otherwise
 * is not just inconsistent: someone revoking a lost or stolen device would
 * believe its contents were wiped when they were not.
 */
const descriptions = {
  trusted: msg`The device will be signed out and lose access to your synced data, and it will need to sign in again to use sync. Data already stored on it is not erased remotely — that device is asked whether to keep or delete its local copy. Your recovery phrase keeps working.`,
  pending: msg`This will deny the device access to your encrypted data. The device will need to set up sync again.`,
  cli: msg`The CLI will be signed out and must sign in again before it can use your Thunderbolt account.`,
}

export const RevokeDeviceDialog = ({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  variant,
  error,
  errorAction,
}: RevokeDeviceDialogProps) => {
  const { i18n, t } = useLingui()
  const isPendingVariant = variant === 'pending'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isPendingVariant ? (
              <Trans>Deny this device?</Trans>
            ) : variant === 'cli' ? (
              <Trans>Revoke this CLI?</Trans>
            ) : (
              <Trans>Revoke this device?</Trans>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>{i18n._(descriptions[variant])}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <div className="flex flex-col gap-2">
            <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
              {error}
            </p>
            {errorAction}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          {/*
            A plain Button, NOT AlertDialogAction, which is a Radix
            `DialogPrimitive.Close` and would dismiss the dialog on click whether
            the mutation resolved or rejected — the second half of THU-887. The
            caller closes it from the mutation's own success callback instead, so a
            failure keeps this button on screen as the retry affordance. Same
            reasoning (and the same shape) as the Change Recovery Phrase dialog.
          */}
          <Button
            onClick={onConfirm}
            disabled={isPending}
            isLoading={isPending}
            loadingLabel={isPendingVariant ? t`Denying…` : t`Revoking…`}
          >
            {isPendingVariant ? <Trans>Deny</Trans> : <Trans>Revoke</Trans>}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
