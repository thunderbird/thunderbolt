/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { OnboardingStepHeader } from '@/components/onboarding/onboarding-step-header'
import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPSlots } from '@/components/ui/input-otp'
import { otpLength } from '@/lib/constants'
import { useBrandingLinks } from '@/lib/branding-selectors'
import { usePasskeyAvailable } from '@/lib/passkey'
import { Trans, useLingui } from '@lingui/react/macro'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { Fingerprint } from 'lucide-react'
import { useId } from 'react'
import type { useWaitlistState } from './use-waitlist-state'
import { WaitlistHeader } from './waitlist-header'
import { WaitlistLanguagePicker } from './waitlist-language-picker'

type WaitlistContentProps = {
  waitlist: ReturnType<typeof useWaitlistState>
  embedded?: boolean
}

/** Shared early-access and approved-account form for the waitlist page and onboarding. */
export const WaitlistContent = ({ waitlist, embedded = false }: WaitlistContentProps) => {
  const { t } = useLingui()
  const links = useBrandingLinks()
  const otpPromptId = useId()
  const { state, isValidEmail, actions } = waitlist

  const isVerifying = state.status === 'verifying'
  const email = state.email
  const passkeyAvailable = usePasskeyAvailable()

  if (state.status === 'checkEmail' || state.status === 'verifying') {
    return (
      <>
        {!embedded && <BackButton onClick={actions.reset} disabled={isVerifying} className="absolute left-6 top-6" />}

        <div
          className={
            embedded
              ? 'flex w-full flex-1 flex-col items-center justify-center gap-6'
              : 'flex w-full flex-1 flex-col items-center p-4'
          }
        >
          {!embedded && <WaitlistHeader />}

          {embedded ? (
            <OnboardingStepHeader
              icon={<AppLogo size={56} />}
              title={<Trans>Check your email</Trans>}
              description={
                <Trans>
                  We&apos;ve sent an email to <span className="font-medium text-foreground">{email}</span> with your
                  next steps.
                </Trans>
              }
            />
          ) : (
            <div className="mt-auto flex flex-col items-center text-center md:my-auto">
              <p className="font-sans text-[28px] font-medium leading-normal text-foreground">
                <Trans>Check your email</Trans>
              </p>
              <p className="mt-2 text-base text-muted-foreground">
                <Trans>
                  We&apos;ve sent an email to <span className="font-medium text-foreground">{email}</span> with your
                  next steps.
                </Trans>
              </p>
            </div>
          )}

          <div
            className={
              embedded
                ? 'flex w-full flex-col items-center gap-4'
                : 'mb-auto mt-8 flex w-full flex-col items-center gap-4 md:mb-0 md:mt-0'
            }
          >
            <p id={otpPromptId} className="text-sm text-muted-foreground">
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
              aria-labelledby={otpPromptId}
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
      </>
    )
  }

  return (
    <div
      className={
        embedded
          ? 'flex w-full flex-1 flex-col items-center justify-center gap-6'
          : 'flex w-full flex-1 flex-col items-center justify-between p-4'
      }
    >
      {!embedded && <WaitlistHeader />}

      <div className="flex w-full flex-col items-center gap-8">
        {embedded ? (
          <OnboardingStepHeader
            icon={<AppLogo size={56} />}
            title={<Trans>Want early access?</Trans>}
            description={<Trans>Join the waitlist or sign in if you already have access.</Trans>}
          />
        ) : (
          <p className="text-center font-sans text-[28px] font-medium leading-normal text-foreground">
            <Trans>Want early access?</Trans>
          </p>
        )}

        <form onSubmit={actions.handleSubmit} className="flex w-full flex-col gap-4">
          <Input
            type="email"
            inputMode="email"
            placeholder={t`Email`}
            aria-label={t`Email`}
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
            disabled={!isValidEmail || state.passkeyPending}
            className="h-[46px] w-full rounded-xl text-base"
          >
            <Trans>Continue</Trans>
          </Button>

          {passkeyAvailable && (
            <>
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">
                  <Trans>or</Trans>
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <Button
                type="button"
                variant="outline"
                isLoading={state.passkeyPending}
                disabled={state.status === 'joining'}
                onClick={actions.handlePasskeySignIn}
                className="h-[46px] w-full rounded-xl text-base font-medium"
              >
                <Fingerprint className="mr-2 h-4 w-4" />
                <Trans>Sign in with passkey</Trans>
              </Button>
            </>
          )}
        </form>
      </div>

      <div className="flex flex-col items-center gap-4">
        <p className="text-center text-xs text-muted-foreground">
          <Trans>
            By continuing, you agree to our{' '}
            <a
              href={links.termsOfService}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href={links.privacyPolicy}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Privacy Policy
            </a>
            .
          </Trans>
        </p>
        {!embedded && <WaitlistLanguagePicker />}
      </div>
    </div>
  )
}
