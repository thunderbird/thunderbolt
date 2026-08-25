/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ActionFeedbackButton } from '@/components/ui/action-feedback-button'
import { Button } from '@/components/ui/button'
import { GradientMail } from '@/components/ui/gradient-mail'
import { GradientTriangleAlert } from '@/components/ui/gradient-triangle-alert'
import { InputOTP, InputOTPSlots } from '@/components/ui/input-otp'
import { otpLength } from '@/lib/constants'
import { cn } from '@/lib/utils'
import { Trans, useLingui } from '@lingui/react/macro'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { Check, Loader2 } from 'lucide-react'

type SignInOtpStepProps = {
  email: string
  otp: string
  status: 'sent' | 'verifying'
  errorMessage: string
  isLocalhost: boolean
  onOtpChange: (otp: string) => void
  onOtpComplete: (otp: string) => void
  onResend: () => Promise<boolean>
  onCancel: () => void
  variant: 'modal' | 'page'
}

/**
 * OTP verification step for sign-in form.
 *
 * Page variant: title + subtitle centered, OTP input at bottom (matches Figma).
 * Modal variant: icon + headline + OTP input + cancel button.
 */
export const SignInOtpStep = ({
  email,
  otp,
  status,
  errorMessage,
  isLocalhost,
  onOtpChange,
  onOtpComplete,
  onResend,
  onCancel,
  variant,
}: SignInOtpStepProps) => {
  const { t } = useLingui()
  const isVerifying = status === 'verifying'

  // Shared building blocks — the page and modal variants are pure layout
  // around these, so the OTP wiring and copy can't drift between them.
  // `autoComplete` differs: the page invites the OS code suggestion, the
  // modal opts out because its input sits beside magic-link instructions.
  const renderOtpInput = (autoComplete: 'one-time-code' | 'off') => (
    <InputOTP
      maxLength={otpLength}
      pattern={REGEXP_ONLY_DIGITS}
      value={otp}
      onChange={onOtpChange}
      onComplete={onOtpComplete}
      disabled={isVerifying}
      autoFocus
      autoComplete={autoComplete}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      containerClassName="w-full"
    >
      <InputOTPSlots />
    </InputOTP>
  )

  const errorLine = errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null

  const renderResendButton = (className?: string) => (
    <ActionFeedbackButton
      variant="ghost"
      size="sm"
      onClick={onResend}
      disabled={isVerifying}
      className={cn('text-muted-foreground hover:text-foreground', className)}
      successContent={
        <>
          <Check className="mr-2 h-4 w-4" />
          <Trans>Sent</Trans>
        </>
      }
    >
      <Trans>Resend Email</Trans>
    </ActionFeedbackButton>
  )

  if (variant === 'page') {
    return (
      <div className="flex h-full w-full flex-col items-center">
        {/* Title + subtitle — centered vertically */}
        <div className="my-auto flex flex-col items-center text-center">
          <p className="font-sans text-[28px] font-medium leading-normal text-foreground">
            <Trans>Check your email</Trans>
          </p>
          <p className="mt-2 text-base text-foreground">
            <Trans>
              If you have access, we&apos;ve sent an 8-digit code to <span className="font-bold">{email}</span>
            </Trans>
          </p>
          {renderResendButton('mt-1')}
        </div>

        {/* OTP input + feedback at bottom */}
        <div className="flex w-full flex-col items-center gap-4">
          {renderOtpInput('one-time-code')}

          {errorLine}

          <Button
            type="button"
            onClick={() => onOtpComplete(otp)}
            isLoading={isVerifying}
            loadingLabel={t`Verifying…`}
            disabled={otp.length !== otpLength}
            // Deliberate hero-CTA treatment for the auth flows (taller than
            // the standard button and rounded-xl instead of the usual
            // rounded-lg atom tier) — matches waitlist-page.tsx.
            className="h-[46px] w-full rounded-xl bg-foreground text-background text-base font-medium hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            <Trans>Continue</Trans>
          </Button>
        </div>
      </div>
    )
  }

  // --- Modal variant (existing design) ---
  return (
    <div className="flex h-full w-full flex-col items-center md:h-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center md:flex-none">
        {isLocalhost ? <GradientTriangleAlert className="h-12 w-12" /> : <GradientMail className="h-12 w-12" />}

        <div className="mt-4 text-center">
          <p className="text-xl font-semibold">
            {isLocalhost ? <Trans>Check the backend logs</Trans> : <Trans>Check your email</Trans>}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {isLocalhost ? (
              <Trans>
                You appear to be using a{' '}
                <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">localhost</code> backend. Check your
                backend server logs for the code or magic link.
              </Trans>
            ) : (
              <Trans>
                We sent a code to <span className="font-medium text-foreground">{email}</span>
              </Trans>
            )}
          </p>
        </div>

        <div className="mt-6 flex w-full flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">
            <Trans>Or enter the 8-digit code</Trans>
          </p>
          {renderOtpInput('off')}

          {isVerifying && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <Trans>Verifying…</Trans>
            </div>
          )}

          {errorLine}

          {renderResendButton()}

          {!isLocalhost && (
            <p className="text-xs text-muted-foreground">
              <Trans>Or click the magic link in your email</Trans>
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 w-full shrink-0">
        <Button variant="outline" className="w-full" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </div>
  )
}
