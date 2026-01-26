import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts'
import { useSignInFormState } from '@/components/sign-in'
import { Brain, Loader2, RefreshCw } from 'lucide-react'
import { Link, useNavigate } from 'react-router'

/**
 * Sign-in page at /waitlist/signin.
 * Dark themed page matching the waitlist design.
 */
export const WaitlistSignInPage = () => {
  const navigate = useNavigate()
  const authClient = useAuth()

  const handleSuccess = () => {
    navigate('/', { replace: true })
  }

  const { state, isValidEmail, actions } = useSignInFormState({
    authClient,
    onSuccess: handleSuccess,
  })

  // OTP verification state
  if (state.status === 'sent' || state.status === 'verifying') {
    return (
      <div className="flex h-[600px] w-[430px] flex-col items-center overflow-clip rounded-[16px] border border-[#475467] bg-[#1a2329] p-8 backdrop-blur-[5px]">
        {/* Header */}
        <div className="flex items-center gap-1">
          <AppLogo size={16} className="!fill-[#DCE875]" />
          <span className="font-brand text-xl font-medium leading-7 tracking-[-0.4px] text-[#f2f7fc]">Thunderbolt</span>
        </div>

        {/* OTP message */}
        <div className="flex flex-1 flex-col items-center justify-center text-center font-sans">
          <h1 className="text-[28px] font-medium leading-normal text-white">Check your email</h1>
          <p className="mt-4 text-base font-normal leading-6 text-[#98a2b3]">
            We've sent a 6-digit code at
            <br />
            <span className="font-medium text-[#f2f7fc]">{state.email}</span>
          </p>
        </div>

        {/* OTP Form */}
        <div className="flex w-full flex-col items-center gap-4 py-8">
          <div className="flex w-full flex-col gap-4">
            <Input
              type="text"
              inputMode="numeric"
              placeholder="6-digit code"
              value={state.otp}
              onChange={(e) => actions.setOtp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && state.otp.length === 6) {
                  actions.handleOtpComplete(state.otp)
                }
              }}
              disabled={state.status === 'verifying'}
              maxLength={6}
              className="h-[46px] rounded-[12px] border border-[#475467] bg-[#263035] px-3 text-center text-base leading-6 tracking-widest text-[#f2f7fc] placeholder:text-[#98a2b3]"
              autoComplete="one-time-code"
              autoFocus
            />

            {state.errorMessage && <p className="text-center text-sm text-destructive">{state.errorMessage}</p>}

            <Button
              type="button"
              onClick={() => actions.handleOtpComplete(state.otp)}
              disabled={state.status === 'verifying' || state.otp.length !== 6}
              className={`h-[46px] w-full rounded-[12px] px-4 py-3 text-base font-medium leading-6 ${
                state.otp.length === 6
                  ? 'bg-white text-black hover:bg-gray-100'
                  : 'bg-[#3d4a54] text-[#98a2b3] disabled:opacity-50'
              }`}
            >
              {state.status === 'verifying' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                'Continue'
              )}
            </Button>
          </div>

          <p className="font-sans text-base font-normal leading-6 text-[#f2f7fc]">
            <button
              type="button"
              onClick={actions.goBack}
              className="text-[#5fa0d9] underline decoration-solid underline-offset-[7%]"
            >
              Go back
            </button>
          </p>
        </div>
      </div>
    )
  }

  // Email input state
  return (
    <div className="flex h-[600px] w-[430px] flex-col items-center overflow-clip rounded-[16px] border border-[#475467] bg-[#1a2329] p-8 backdrop-blur-[5px]">
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

        {/* Content */}
        <div className="flex flex-col items-center gap-6">
          <h1 className="font-sans text-[28px] font-medium leading-normal text-white">Sign Up or Log In</h1>

          {/* Feature cards */}
          <div className="flex w-full flex-col gap-4 rounded-[12px] bg-[#263035] px-3 py-4">
            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center">
                <RefreshCw className="size-6 text-sky-400" />
              </div>
              <p className="font-sans text-base font-normal leading-6 text-[#d0d5dd]">Sync chats between devices</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center">
                <Brain className="size-6 text-violet-400" />
              </div>
              <p className="font-sans text-base font-normal leading-6 text-[#d0d5dd]">Access more powerful AI models</p>
            </div>
          </div>
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
              disabled={state.status === 'sending'}
              className="h-[46px] rounded-[12px] border border-[#475467] bg-[#263035] px-3 py-2.5 text-base leading-6 text-[#f2f7fc] placeholder:text-[#98a2b3]"
              autoComplete="email"
            />

            {state.status === 'error' && <p className="text-sm text-destructive">{state.errorMessage}</p>}

            <Button
              type="submit"
              disabled={state.status === 'sending' || !isValidEmail}
              className={`h-[46px] w-full rounded-[12px] px-4 py-3 text-base font-medium leading-6 ${
                isValidEmail
                  ? 'bg-white text-black hover:bg-gray-100'
                  : 'bg-[#3d4a54] text-[#98a2b3] disabled:opacity-50'
              }`}
            >
              {state.status === 'sending' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                'Continue'
              )}
            </Button>
          </form>

          {/* Back to waitlist link */}
          <p className="font-sans text-base font-normal leading-6 text-[#f2f7fc]">
            <Link to="/waitlist" className="text-[#5fa0d9] underline decoration-solid underline-offset-[7%]">
              Back to waitlist
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}

export default WaitlistSignInPage
