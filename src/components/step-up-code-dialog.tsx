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
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPSlots } from '@/components/ui/input-otp'
import { stepUpOtpLength } from '@/settings/encryption/use-change-recovery-key'

type StepUpCodeDialogProps = {
  open: boolean
  otp: string
  isBusy: boolean
  error: string | null
  onOtpChange: (otp: string) => void
  onResend: () => void
  onSubmit: () => void
  onCancel: () => void
}

/**
 * Emailed step-up code entry (THU-875) — the server refuses a recovery-phrase
 * change without it. Shared by the settings "Change recovery phrase" flow and
 * the unsaved-phrase prompt, which both end in the same gated rotation.
 */
export const StepUpCodeDialog = ({
  open,
  otp,
  isBusy,
  error,
  onOtpChange,
  onResend,
  onSubmit,
  onCancel,
}: StepUpCodeDialogProps) => (
  <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && !isBusy && onCancel()}>
    {/* sm:max-w-md matches the sign-in modal, so the OTP slots render at the
        exact width users already know from sign-in. */}
    <AlertDialogContent className="sm:max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle>Enter your verification code</AlertDialogTitle>
        <AlertDialogDescription>
          We sent an 8-digit code to your account email. Enter it to generate your new recovery phrase.
        </AlertDialogDescription>
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
        <InputOTPSlots />
      </InputOTP>
      {error && (
        <p className="text-sm text-destructive text-center" role="alert">
          {error}
        </p>
      )}
      <AlertDialogFooter className="flex-col sm:flex-col">
        <Button
          className="w-full"
          onClick={onSubmit}
          isLoading={isBusy}
          loadingLabel="Generating…"
          disabled={otp.length !== stepUpOtpLength}
        >
          Generate new phrase
        </Button>
        <Button className="w-full" variant="ghost" onClick={onResend} disabled={isBusy}>
          Resend code
        </Button>
        <AlertDialogCancel className="w-full" disabled={isBusy}>
          Cancel
        </AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
)
