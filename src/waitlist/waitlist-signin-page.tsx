import { SignInForm } from '@/components/sign-in'
import { ArrowLeft } from 'lucide-react'
import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { WaitlistCard } from './waitlist-card'
import { WaitlistHeader } from './waitlist-header'

/**
 * Sign-in page at /waitlist/signin.
 * Dark themed page matching the waitlist design.
 * Uses the shared SignInForm component with a dark theme wrapper.
 *
 * When navigated from the waitlist with an approved email, pre-fills the email input.
 */
export const WaitlistSignInPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const locationState = location.state as { email?: string; skipToOtp?: boolean } | null
  const initialEmail = locationState?.email
  const skipToOtp = locationState?.skipToOtp ?? false
  const [isOnOtpStep, setIsOnOtpStep] = useState(false)
  const goBackRef = useRef<(() => void) | null>(null)

  const handleBackClick = () => {
    if (isOnOtpStep && goBackRef.current) {
      goBackRef.current()
    } else {
      navigate('/waitlist')
    }
  }

  /** Redirect non-approved users to waitlist success page */
  const handleNotApproved = (email: string) => {
    navigate('/waitlist', { state: { email, showSuccess: true } })
  }

  return (
    <WaitlistCard>
      {/* Back arrow */}
      <button
        type="button"
        onClick={handleBackClick}
        className="absolute left-6 top-6 flex size-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted"
        aria-label="Back to waitlist"
      >
        <ArrowLeft className="size-5" />
      </button>

      <div className="flex w-full flex-1 flex-col items-center p-4">
        <WaitlistHeader />

        {/* Form content — title is now inside each step component */}
        <div className="mt-4 w-full flex-1 text-foreground">
          <SignInForm
            variant="page"
            onSuccess={() => navigate('/', { replace: true })}
            onCancel={() => navigate('/waitlist')}
            onEmailSent={() => setIsOnOtpStep(true)}
            onGoBack={() => setIsOnOtpStep(false)}
            goBackRef={goBackRef}
            initialEmail={initialEmail}
            skipToOtp={skipToOtp}
            onNotApproved={handleNotApproved}
          />
        </div>
      </div>
    </WaitlistCard>
  )
}

export default WaitlistSignInPage
