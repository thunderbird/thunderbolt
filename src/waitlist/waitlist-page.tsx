import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { useAuth } from '@/contexts'
import { privacyPolicyUrl, termsOfServiceUrl } from '@/lib/constants'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useWaitlistState } from './use-waitlist-state'
import { WaitlistCard } from './waitlist-card'
import { WaitlistHeader } from './waitlist-header'

/**
 * Unified entry page at /waitlist.
 * Single screen for both new users and existing users — enter email, then check email.
 *
 * Privacy note: All users see the same "check your email" screen regardless of their actual status.
 * The backend sends different emails based on whether they're approved, pending, or new.
 */
export const WaitlistPage = () => {
  const authClient = useAuth()
  const navigate = useNavigate()
  const { state, isValidEmail, actions } = useWaitlistState({
    authClient,
    onVerified: () => navigate('/', { replace: true }),
  })

  const isVerifying = state.status === 'verifying'

  if (state.status === 'checkEmail' || state.status === 'verifying') {
    return (
      <WaitlistCard>
        <BackButton onClick={actions.reset} className="absolute left-6 top-6" />

        <div className="flex w-full flex-1 flex-col items-center p-4">
          <WaitlistHeader />

          <div className="my-auto flex flex-col items-center text-center">
            <p className="font-sans text-[28px] font-medium leading-normal text-foreground">Check your email</p>
            <p className="mt-2 text-base text-muted-foreground">
              We&apos;ve sent an email to <span className="font-medium text-foreground">{state.email}</span> with your
              next steps.
            </p>
          </div>

          <div className="flex w-full flex-col items-center gap-4">
            <p className="text-sm text-muted-foreground">If you received a code to log in, enter it here:</p>
            <InputOTP
              maxLength={8}
              pattern={REGEXP_ONLY_DIGITS}
              value={state.otp}
              onChange={actions.setOtp}
              onComplete={actions.handleOtpComplete}
              disabled={isVerifying}
              autoFocus
              autoComplete="one-time-code"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
            >
              <InputOTPGroup className="gap-2">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <InputOTPSlot key={i} index={i} className="h-12 w-12 shrink-0 rounded-lg" />
                ))}
              </InputOTPGroup>
            </InputOTP>

            {state.errorMessage && <p className="text-sm text-destructive">{state.errorMessage}</p>}

            <Button
              type="button"
              onClick={() => actions.handleOtpComplete(state.otp)}
              disabled={isVerifying || state.otp.length !== 8}
              className="h-[46px] w-full rounded-[12px] text-base"
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
      </WaitlistCard>
    )
  }

  return (
    <WaitlistCard>
      <div className="flex w-full flex-1 flex-col items-center justify-between p-4">
        <WaitlistHeader />

        <div className="flex w-full flex-col items-center gap-8">
          <div className="text-center font-sans">
            <p className="text-[28px] font-medium leading-normal text-foreground">Wanna try the beta?</p>
          </div>

          <form onSubmit={actions.handleSubmit} className="flex w-full flex-col gap-4">
            <Input
              type="email"
              inputMode="email"
              placeholder="Email"
              value={state.email}
              onChange={(e) => actions.setEmail(e.target.value)}
              disabled={state.status === 'joining'}
              variant="filled"
              inputSize="xl"
              className="w-full rounded-xl"
              autoComplete="email"
            />

            {state.status === 'error' && <p className="text-sm text-destructive">{state.errorMessage}</p>}

            <Button
              type="submit"
              disabled={state.status === 'joining' || !isValidEmail}
              className="h-[46px] w-full rounded-[12px] text-base"
            >
              {state.status === 'joining' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                'Continue'
              )}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          By continuing, you agree to our{' '}
          <a
            href={termsOfServiceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            Terms of Service
          </a>{' '}
          and{' '}
          <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </WaitlistCard>
  )
}

export default WaitlistPage
