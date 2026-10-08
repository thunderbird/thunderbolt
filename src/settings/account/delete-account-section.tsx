/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { StepUpCodeDialog } from '@/components/step-up-code-dialog'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { useDeleteAccount } from './use-delete-account'

/**
 * Account deletion: confirm, then an emailed code, then the delete. Two
 * sequential dialogs rather than one — `ConfirmActionDialog` has no slot for
 * an OTP field, and its mobile action sheet is the wrong shape for one.
 */
export const DeleteAccountSection = () => {
  const { t } = useLingui()
  const { status, isBusy, otp, error, openConfirm, cancel, setOtp, requestStepUpCode, confirmDeletion } =
    useDeleteAccount()

  return (
    <>
      <div className="h-px bg-border -mx-6" />

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">
          <Trans>Delete Your Account</Trans>
        </label>
        <p className="text-sm text-muted-foreground">
          <Trans>Permanently delete your account and all data on our servers and this device.</Trans>
        </p>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {/* Secondary on the page; the red danger styling lives on the
            confirm button inside the dialog. */}
        <Button variant="secondary" disabled={isBusy} onClick={openConfirm}>
          {isBusy ? t`Deleting…` : t`Delete My Account`}
        </Button>

        <ConfirmActionDialog
          open={status === 'confirming'}
          title={t`Delete your account?`}
          description={t`This will permanently delete your account and all of your data on our servers and on this device, including settings, chat history, and cached information. This action cannot be undone.`}
          confirmLabel={t`Send code`}
          isPending={isBusy}
          // Not pre-closed: `CODE_SENT` closes this by advancing the status, so
          // a failed request leaves the dialog up. Guarded because Escape and
          // the backdrop fire onCancel even while the buttons are disabled.
          onConfirm={() => void requestStepUpCode()}
          onCancel={() => {
            if (!isBusy) {
              cancel()
            }
          }}
        />

        <StepUpCodeDialog
          open={status === 'stepUp'}
          otp={otp}
          isBusy={isBusy}
          error={error}
          description={t`We sent an 8-digit code to your account email. Enter it to permanently delete your account.`}
          submitLabel={t`Delete account`}
          submitLoadingLabel={t`Deleting…`}
          submitVariant="destructive"
          onOtpChange={setOtp}
          onResend={requestStepUpCode}
          onSubmit={confirmDeletion}
          onCancel={cancel}
        />
      </div>
    </>
  )
}
