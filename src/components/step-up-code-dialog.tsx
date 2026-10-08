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
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPSlots } from '@/components/ui/input-otp'
import { stepUpOtpLength } from '@/lib/constants'

type StepUpCodeDialogProps = {
  open: boolean
  otp: string
  isBusy: boolean
  error: string | null
  /** What the code is about to authorize — each flow says it in its own words. */
  description: string
  submitLabel: string
  submitLoadingLabel: string
  submitVariant?: 'default' | 'destructive'
  onOtpChange: (otp: string) => void
  onResend: () => void
  onSubmit: () => void
  onCancel: () => void
}

/**
 * Emailed step-up code entry — the server refuses a gated action without it.
 * The copy is required rather than defaulted: every flow states the action it
 * is about to take, and a default would quietly let one borrow another's words.
 */
export const StepUpCodeDialog = ({
  open,
  otp,
  isBusy,
  error,
  description,
  submitLabel,
  submitLoadingLabel,
  submitVariant,
  onOtpChange,
  onResend,
  onSubmit,
  onCancel,
}: StepUpCodeDialogProps) => {
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && !isBusy && onCancel()}>
      {/* sm:max-w-md matches the sign-in modal, so the OTP slots render at the
        exact width users already know from sign-in. */}
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Enter your verification code</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <InputOTP
          maxLength={stepUpOtpLength}
          pattern={REGEXP_ONLY_DIGITS}
          value={otp}
          onChange={onOtpChange}
          onComplete={onSubmit}
          disabled={isBusy}
          autoFocus
          autoComplete="one-time-code"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          containerClassName="w-full"
        >
          <InputOTPSlots length={stepUpOtpLength} />
        </InputOTP>
        {error && (
          <p className="text-sm text-destructive text-center" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter className="flex-col sm:flex-col">
          <Button
            className="w-full"
            variant={submitVariant}
            onClick={onSubmit}
            isLoading={isBusy}
            loadingLabel={submitLoadingLabel}
            disabled={otp.length !== stepUpOtpLength}
          >
            {submitLabel}
          </Button>
          <Button className="w-full" variant="ghost" onClick={onResend} disabled={isBusy}>
            <Trans>Resend code</Trans>
          </Button>
          <AlertDialogCancel className="w-full" disabled={isBusy}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
