import { ActionFeedbackButton } from '@/components/ui/action-feedback-button'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { otpLength } from '@/lib/constants'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { AlertTriangle, Check, Loader2, Mail } from 'lucide-react'

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
  const isVerifying = status === 'verifying'

  if (variant === 'page') {
    return (
      <div className="flex h-full w-full flex-col items-center">
        {/* Title + subtitle — centered vertically */}
        <div className="my-auto flex flex-col items-center text-center">
          <p className="font-sans text-[28px] font-medium leading-normal text-foreground">Check your email</p>
          <p className="mt-2 text-base text-foreground">
            If you have access, we&apos;ve sent an 8-digit code to <span className="font-bold">{email}</span>
          </p>
          <ActionFeedbackButton
            variant="ghost"
            size="sm"
            onClick={onResend}
            disabled={isVerifying}
            className="mt-1 text-muted-foreground hover:text-foreground"
            successContent={
              <>
                <Check className="mr-2 h-4 w-4" />
                Sent
              </>
            }
          >
            Resend Email
          </ActionFeedbackButton>
        </div>

        {/* OTP input + feedback at bottom */}
        <div className="flex w-full flex-col items-center gap-4">
          <InputOTP
            maxLength={otpLength}
            pattern={REGEXP_ONLY_DIGITS}
            value={otp}
            onChange={onOtpChange}
            onComplete={onOtpComplete}
            disabled={isVerifying}
            autoFocus
            autoComplete="one-time-code"
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            containerClassName="w-full"
          >
            <InputOTPGroup className="w-full gap-2">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <InputOTPSlot key={i} index={i} className="flex-1 rounded-lg" />
              ))}
            </InputOTPGroup>
          </InputOTP>

          {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

          <Button
            type="button"
            onClick={() => onOtpComplete(otp)}
            disabled={isVerifying || otp.length !== otpLength}
            className="h-[46px] w-full rounded-[12px] bg-foreground text-background text-base font-medium hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            {isVerifying ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              'Continue'
            )}
          </Button>
        </div>
      </div>
    )
  }

  // --- Modal variant (existing design) ---
  return (
    <div className="flex w-full flex-col items-center">
      {/* Icon */}
      {isLocalhost ? (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/30">
          <AlertTriangle className="h-8 w-8 text-yellow-600 dark:text-yellow-400" />
        </div>
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Mail className="h-8 w-8 text-primary" />
        </div>
      )}

      {/* Headline */}
      <div className="mt-4 text-center">
        <p className="text-xl font-semibold">{isLocalhost ? 'Check the backend logs' : 'Check your email'}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {isLocalhost ? (
            <>
              You appear to be using a <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">localhost</code>{' '}
              backend. Check your backend server logs for the code or magic link.
            </>
          ) : (
            <>
              We sent a code to <span className="font-medium text-foreground">{email}</span>
            </>
          )}
        </p>
      </div>

      {/* OTP Input */}
      <div className="mt-6 flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">Or enter the 8-digit code</p>
        <InputOTP
          maxLength={otpLength}
          pattern={REGEXP_ONLY_DIGITS}
          value={otp}
          onChange={onOtpChange}
          onComplete={onOtpComplete}
          disabled={isVerifying}
          autoFocus
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          containerClassName="w-full"
        >
          <InputOTPGroup className="w-full gap-2">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <InputOTPSlot key={i} index={i} className="flex-1 rounded-lg" />
            ))}
          </InputOTPGroup>
        </InputOTP>

        {isVerifying && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Verifying...
          </div>
        )}

        {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

        <ActionFeedbackButton
          variant="ghost"
          size="sm"
          onClick={onResend}
          disabled={isVerifying}
          className="text-muted-foreground hover:text-foreground"
          successContent={
            <>
              <Check className="mr-2 h-4 w-4" />
              Sent
            </>
          }
        >
          Resend Email
        </ActionFeedbackButton>

        {!isLocalhost && <p className="text-xs text-muted-foreground">Or click the magic link in your email</p>}
      </div>

      {/* Cancel button */}
      <div className="mt-6 w-full">
        <Button variant="outline" className="w-full" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
