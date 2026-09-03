/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPSlots } from '@/components/ui/input-otp'
import { useAuth } from '@/contexts'
import { otpLength, privacyPolicyUrl, termsOfServiceUrl } from '@/lib/constants'
import { Trans, useLingui } from '@lingui/react/macro'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { useNavigate } from 'react-router'
import { useWaitlistState } from './use-waitlist-state'
import { WaitlistCard } from './waitlist-card'
import { WaitlistHeader } from './waitlist-header'
import { WaitlistLanguagePicker } from './waitlist-language-picker'

/**
 * Unified entry page at /waitlist.
 * Single screen for both new users and existing users — enter email, then check email.
 *
 * Privacy note: All users see the same "check your email" screen regardless of their actual status.
 * The backend sends different emails based on whether they're approved, pending, or new.
 */
export const WaitlistPage = () => {
  const { t } = useLingui()
  const authClient = useAuth()
  const navigate = useNavigate()
  const { state, isValidEmail, actions } = useWaitlistState({
    authClient,
    onVerified: () => navigate('/', { replace: true }),
  })

  const isVerifying = state.status === 'verifying'
  const email = state.email

  if (state.status === 'checkEmail' || state.status === 'verifying') {
    return (
      <WaitlistCard>
        <BackButton onClick={actions.reset} className="absolute left-6 top-6" />

        <div className="flex w-full flex-1 flex-col items-center p-4">
          <WaitlistHeader />

          <div className="mt-auto flex flex-col items-center text-center md:my-auto">
            <p className="font-sans text-[28px] font-medium leading-normal text-foreground">
              <Trans>Check your email</Trans>
            </p>
            <p className="mt-2 text-base text-muted-foreground">
              {/* Bound to a local so the catalog placeholder is named `{email}`
                  rather than positional `{0}` — a member expression gives the
                  extractor no name to use. */}
              <Trans>
                We&apos;ve sent an email to <span className="font-medium text-foreground">{email}</span> with your next
                steps.
              </Trans>
            </p>
          </div>

          <div className="mb-auto mt-8 flex w-full flex-col items-center gap-4 md:mb-0 md:mt-0">
            <p className="text-sm text-muted-foreground">
              <Trans>If you received a code to log in, enter it here:</Trans>
            </p>
            <InputOTP
              maxLength={otpLength}
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
              containerClassName="w-full"
            >
              <InputOTPSlots />
            </InputOTP>

            {state.errorMessage && <p className="text-sm text-destructive">{state.errorMessage}</p>}

            <Button
              type="button"
              onClick={() => actions.handleOtpComplete(state.otp)}
              isLoading={isVerifying}
              loadingLabel={t`Verifying…`}
              disabled={state.otp.length !== otpLength}
              className="h-[46px] w-full rounded-xl text-base"
            >
              <Trans>Continue</Trans>
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
            <p className="text-[28px] font-medium leading-normal text-foreground">
              <Trans>Want early access?</Trans>
            </p>
          </div>

          <form onSubmit={actions.handleSubmit} className="flex w-full flex-col gap-4">
            <Input
              type="email"
              inputMode="email"
              placeholder={t`Email`}
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
              isLoading={state.status === 'joining'}
              loadingLabel={t`Sending…`}
              disabled={!isValidEmail}
              className="h-[46px] w-full rounded-xl text-base"
            >
              <Trans>Continue</Trans>
            </Button>
          </form>
        </div>

        <div className="flex flex-col items-center gap-4">
          <p className="text-center text-xs text-muted-foreground">
            <Trans>
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
              <a
                href={privacyPolicyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Privacy Policy
              </a>
              .
            </Trans>
          </p>
          <WaitlistLanguagePicker />
        </div>
      </div>
    </WaitlistCard>
  )
}

export default WaitlistPage
