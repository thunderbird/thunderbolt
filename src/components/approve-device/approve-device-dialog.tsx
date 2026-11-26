/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import type { Device } from '@/dal'
import type { DeviceApprovalConfirmation } from '@/services/encryption'
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ApprovalCodeOptions } from './approval-code-options'
import { FingerprintConfirmation } from './fingerprint-confirmation'
import { useApproveDeviceDialogState } from './use-approve-device-dialog-state'

type ApproveDeviceDialogProps = {
  device: Pick<Device, 'id' | 'publicKey' | 'mlkemPublicKey'> | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (confirmation: DeviceApprovalConfirmation) => void | Promise<void>
  /** "Deny device": hand over to the caller's existing deny confirmation. */
  onDeny: () => void
  isPending: boolean
}

/**
 * Approve a pending device by picking the code it shows (commit-then-reveal), or by typing its
 * fingerprint. Mounted only while open, so opening starts the attempt; keyed on the recipient keys,
 * so a changed device row starts a fresh one.
 */
export const ApproveDeviceDialog = (props: ApproveDeviceDialogProps) =>
  props.open ? (
    <ApprovalFlow
      key={JSON.stringify([props.device?.id, props.device?.publicKey, props.device?.mlkemPublicKey])}
      {...props}
    />
  ) : null

const ApprovalFlow = ({ device, open, onOpenChange, onConfirm, onDeny, isPending }: ApproveDeviceDialogProps) => {
  const { t } = useLingui()
  const { state, start, pick, noneMatch, chooseFingerprint } = useApproveDeviceDialogState({ device, onConfirm })
  const [chosen, setChosen] = useState<string | null>(null)

  const fingerprintLink = (
    <Button variant="link" size="sm" className="h-auto self-center p-0 sm:self-start" onClick={chooseFingerprint}>
      <Trans>Use fingerprint instead</Trans>
    </Button>
  )
  const cancel = (
    <AlertDialogCancel disabled={isPending}>
      <Trans>Cancel</Trans>
    </AlertDialogCancel>
  )

  const renderStep = () => {
    switch (state.step) {
      case 'connecting':
      case 'pick':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Which code is on the new device?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>Tap the code the new device shows. If none match, don't approve it.</Trans>
              </AlertDialogDescription>
              {fingerprintLink}
            </AlertDialogHeader>
            {/* Six codes plus "none of these", one tight group apart from the dialog's own Cancel. */}
            <div className="grid gap-2">
              <ApprovalCodeOptions
                options={state.step === 'pick' ? state.options : null}
                onPick={(option) => {
                  setChosen(option)
                  void pick(option)
                }}
                disabled={isPending}
                pendingOption={isPending ? chosen : null}
              />
              <Button variant="outline" onClick={noneMatch} disabled={state.step !== 'pick' || isPending}>
                <Trans>None of these match</Trans>
              </Button>
            </div>
            {state.submitError && (
              <p className="text-[length:var(--font-size-sm)] text-destructive" role="alert">
                {state.submitError === 'conflict'
                  ? t`Couldn't complete approval. Close this dialog and check the device list before trying again.`
                  : t`Couldn't approve this device. Please try again.`}
              </p>
            )}
            <AlertDialogFooter>{cancel}</AlertDialogFooter>
          </>
        )
      case 'mismatch':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>The codes didn't match</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  This device was not approved. If you aren't adding a device, deny it. To try again, tap New code on
                  the new device first.
                </Trans>
              </AlertDialogDescription>
              {fingerprintLink}
            </AlertDialogHeader>
            <p role="alert" className="sr-only">
              <Trans>The codes didn't match, so the device was not approved.</Trans>
            </p>
            <AlertDialogFooter>
              {cancel}
              <Button variant="outline" onClick={onDeny}>
                <span className="text-destructive">
                  <Trans>Deny device</Trans>
                </span>
              </Button>
              <Button onClick={start}>
                <Trans>Try again</Trans>
              </Button>
            </AlertDialogFooter>
          </>
        )
      case 'unavailable':
        return (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>The new device isn't showing a code</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>Keep the new device on its approval screen, or tap New code there, then try again.</Trans>
              </AlertDialogDescription>
              {fingerprintLink}
            </AlertDialogHeader>
            <AlertDialogFooter>
              {cancel}
              <Button onClick={start}>
                <Trans>Try again</Trans>
              </Button>
            </AlertDialogFooter>
          </>
        )
      case 'fingerprint':
        return (
          <FingerprintConfirmation
            canConfirm={device !== null}
            onConfirm={onConfirm}
            isPending={isPending}
            limitReached={state.reason === 'limit'}
          />
        )
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>{renderStep()}</AlertDialogContent>
    </AlertDialog>
  )
}
