import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2 } from 'lucide-react'
import { Link } from 'react-router'
import { useWaitlistState } from './use-waitlist-state'

/**
 * Waitlist join page at /waitlist.
 * Shows email input form in idle state and confirmation message in success state.
 */
export const WaitlistPage = () => {
  const { state, isValidEmail, actions } = useWaitlistState()

  // Success state - user has joined the waitlist
  if (state.status === 'success') {
    return (
      <div className="flex h-[600px] w-[430px] flex-col items-center justify-center overflow-clip rounded-[16px] border border-[#475467] bg-[#1a2329] p-8 backdrop-blur-[5px]">
        <div className="flex w-full flex-1 flex-col items-center justify-between p-4">
          {/* Header */}
          <div className="flex w-full flex-col items-center">
            <div className="flex items-center justify-center gap-1">
              <AppLogo size={16} className="!fill-[#DCE875]" />
              <span className="font-brand text-xl font-medium leading-7 tracking-[-0.4px] text-[#f2f7fc]">
                Thunderbolt
              </span>
            </div>
          </div>

          {/* Success message */}
          <div className="text-center font-sans">
            <p className="text-[28px] font-medium leading-normal text-white">We will send you an</p>
            <p className="text-[28px] font-medium leading-normal text-white">email when the</p>
            <p className="text-[28px] font-medium leading-normal text-white">app is ready!</p>
            <p className="mt-4 text-base font-normal leading-6 text-[#98a2b3]">
              {state.email}
              <br />
              has joined the list!
            </p>
          </div>

          {/* Footer */}
          <div className="w-full py-8 text-center">
            <p className="font-sans text-base font-normal leading-6 text-[#f2f7fc]">
              Need any help?{' '}
              <a
                href="mailto:support@thunderbolt.io"
                className="text-[#5fa0d9] underline decoration-solid underline-offset-[7%]"
              >
                Contact our support.
              </a>
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Idle/joining state - email input form
  return (
    <div className="flex h-[600px] w-[430px] flex-col items-center justify-center overflow-clip rounded-[16px] border border-[#475467] bg-[#1a2329] p-8 backdrop-blur-[5px]">
      <div className="flex w-full flex-1 flex-col items-center justify-between p-4">
        {/* Header */}
        <div className="flex w-full flex-col items-center">
          <div className="flex items-center justify-center gap-1">
            <AppLogo size={16} className="!fill-[#DCE875]" />
            <span className="font-brand text-xl font-medium leading-7 tracking-[-0.4px] text-[#f2f7fc]">
              Thunderbolt
            </span>
          </div>
        </div>

        {/* Headline */}
        <div className="text-center font-sans">
          <p className="text-[28px] font-medium leading-normal text-white">We're almost ready.</p>
          <p className="text-[28px] font-medium leading-normal text-white">Join the waitlist?</p>
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
              className="h-[46px] rounded-[12px] border border-[#475467] bg-[#263035] px-3 py-2.5 text-base leading-6 text-[#f2f7fc] placeholder:text-[#98a2b3]"
              autoComplete="email"
            />

            {state.status === 'error' && <p className="text-sm text-destructive">{state.errorMessage}</p>}

            <Button
              type="submit"
              disabled={state.status === 'joining' || !isValidEmail}
              className={`h-[46px] w-full rounded-[12px] px-4 py-3 text-base font-medium leading-6 ${
                isValidEmail
                  ? 'bg-white text-black hover:bg-gray-100'
                  : 'bg-[#3d4a54] text-[#98a2b3] disabled:opacity-50'
              }`}
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
          <p className="font-sans text-base font-normal leading-6 text-[#f2f7fc]">
            Already have an account?{' '}
            <Link to="/waitlist/signin" className="text-[#5fa0d9] underline decoration-solid underline-offset-[7%]">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

export default WaitlistPage
