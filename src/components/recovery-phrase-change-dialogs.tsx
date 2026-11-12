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
import { StepUpCodeDialog } from '@/components/step-up-code-dialog'
import type { useChangeRecoveryKey } from '@/settings/encryption/use-change-recovery-key'
import { Trans, useLingui } from '@lingui/react/macro'

export type RecoveryPhraseChangeFlow = ReturnType<typeof useChangeRecoveryKey>

type RecoveryPhraseChangeDialogsProps = {
  flow: RecoveryPhraseChangeFlow
  confirmTitle: string
  confirmDescription: string
}

/**
 * The three dialogs of a recovery-phrase change: confirm (and email the step-up
 * code), enter the code, then show the new phrase once behind the saved-it gate.
 * Shared by the Preferences row and the continuity migration, which only differ
 * in the confirm copy.
 */
export const RecoveryPhraseChangeDialogs = ({
  flow,
  confirmTitle,
  confirmDescription,
}: RecoveryPhraseChangeDialogsProps) => {
  const { t } = useLingui()
  const {
    status,
    isBusy,
    isSubmitting,
    otp,
    newRecoveryKey,
    error,
    cancel,
    setOtp,
    requestStepUpCode,
    confirmRotation,
    done,
  } = flow

  return (
    <>
      <AlertDialog open={status === 'confirming'} onOpenChange={(open) => !open && !isBusy && cancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            {/* Radix's Cancel closes the dialog itself; a plain Button for the
                confirm keeps the dialog open while the request is in flight
                (and doubles as the retry affordance on failure). */}
            <AlertDialogCancel disabled={isBusy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <Button onClick={requestStepUpCode} isLoading={isBusy} loadingLabel={t`Sending code…`}>
              {error ? t`Try again` : t`Send code`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <StepUpCodeDialog
        open={status === 'stepUp'}
        otp={otp}
        isBusy={isBusy}
        error={error}
        description={t`We sent an 8-digit code to your account email. Enter it to generate your new recovery phrase.`}
        submitLabel={t`Generate new phrase`}
        submitLoadingLabel={t`Generating…`}
        isSubmitting={isSubmitting}
        submitOnComplete
        onOtpChange={setOtp}
        onResend={requestStepUpCode}
        onSubmit={confirmRotation}
        onCancel={cancel}
      />

      <RecoveryKeyDialog
        open={status === 'display'}
        recoveryKey={newRecoveryKey ?? ''}
        title={t`Save your new recovery phrase`}
        description={t`Your old recovery phrase no longer works. Write down these 24 words in order and store them somewhere safe. This phrase won't be shown again.`}
        onDone={done}
      />
    </>
  )
}
