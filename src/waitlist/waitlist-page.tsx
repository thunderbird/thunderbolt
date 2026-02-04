import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useWaitlistState } from './use-waitlist-state'
import { WaitlistCard } from './waitlist-card'
import { WaitlistHeader } from './waitlist-header'

/**
 * Waitlist join page at /waitlist.
 * Shows email input form in idle state and confirmation message in success state.
 *
 * Privacy note: All users see the same success message regardless of their actual status.
 * Emails guide users based on whether they're approved, pending, or already have an account.
 */
export const WaitlistPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const locationState = location.state as { email?: string; showSuccess?: boolean } | null
  const { state, isValidEmail, actions } = useWaitlistState()

  // Redirected from sign-in page (non-eligible user) — show success screen with their email
  const showSuccessEmail = locationState?.showSuccess && locationState.email ? locationState.email : null

  const handleBack = () => {
    actions.reset()
    navigate('/waitlist', { replace: true })
  }

  // Success state - user has joined the waitlist (or was redirected from sign-in)
  if (state.status === 'success' || showSuccessEmail) {
    return (
      <WaitlistCard>
        <BackButton onClick={handleBack} className="absolute left-6 top-6" />

        <div className="flex w-full flex-1 flex-col items-center justify-between p-4">
          <WaitlistHeader />

          {/* Success message */}
          <div className="text-center font-sans">
            <p className="text-[28px] font-medium leading-normal text-foreground">Thanks for signing up!</p>
            <p className="mt-4 text-base font-normal leading-6 text-muted-foreground">
              We'll send you an email when the app is ready for you to join!
            </p>
          </div>

          {/* Footer */}
          <div className="w-full py-8 text-center">
            <p className="font-sans text-base font-normal leading-6 text-foreground">
              Need any help?{' '}
              <a
                href="mailto:support@thunderbolt.io"
                className="text-primary underline decoration-solid underline-offset-[7%]"
              >
                Contact our support.
              </a>
            </p>
          </div>
        </div>
      </WaitlistCard>
    )
  }

  // Idle/joining state - email input form
  return (
    <WaitlistCard>
      <div className="flex w-full flex-1 flex-col items-center justify-between p-4">
        <WaitlistHeader />

        {/* Headline */}
        <div className="text-center font-sans">
          <p className="text-[28px] font-medium leading-normal text-foreground">We're almost ready.</p>
          <p className="text-[28px] font-medium leading-normal text-foreground">Join the waitlist?</p>
        </div>

        {/* Form */}
        <div className="flex w-full flex-col items-center gap-4 py-8">
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
                  Joining...
                </>
              ) : (
                'Join Waitlist'
              )}
            </Button>
          </form>

          {/* Login link */}
          <p className="font-sans text-base font-normal leading-6 text-foreground">
            Already have an account?{' '}
            <Link to="/waitlist/signin" className="text-primary underline decoration-solid underline-offset-[7%]">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </WaitlistCard>
  )
}

export default WaitlistPage
