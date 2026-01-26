import { ActionFeedbackButton } from '@/components/ui/action-feedback-button'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { AlertTriangle, ArrowLeft, Check, Loader2, Mail } from 'lucide-react'

type SignInOtpStepProps = {
  email: string
  otp: string
  status: 'sent' | 'verifying'
  errorMessage: string
  isLocalhost: boolean
  onOtpChange: (otp: string) => void
  onOtpComplete: (otp: string) => void
  onResend: () => Promise<boolean>
  onGoBack: () => void
  onCancel: () => void
  variant: 'modal' | 'page'
}

/**
 * OTP verification step for sign-in form.
 * Shows the 6-digit code input and resend button.
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
  onGoBack,
  onCancel,
  variant,
}: SignInOtpStepProps) => {
  const isVerifying = status === 'verifying'

  return (
    <div className="flex w-full flex-col items-center">
      {/* Back button - only for page variant, modal uses header */}
      {variant === 'page' && (
        <button
          type="button"
          onClick={onGoBack}
          className="absolute left-4 top-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-muted"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      )}

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
        <p className="text-sm text-muted-foreground">Or enter the 6-digit code</p>
        <InputOTP
          maxLength={6}
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
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
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

      {/* Cancel button - for modal variant */}
      {variant === 'modal' && (
        <div className="mt-6 w-full">
          <Button variant="outline" className="w-full" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
