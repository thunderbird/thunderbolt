/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { authButtonClass } from '@/components/auth-screen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Trans, useLingui } from '@lingui/react/macro'
import { Fingerprint, Loader2, Mail } from 'lucide-react'
import { useRef, type FormEvent, type RefObject } from 'react'

type SignInEmailStepProps = {
  email: string
  status: 'idle' | 'sending' | 'error'
  errorMessage: string
  isValidEmail: boolean
  onSubmit: (e: FormEvent) => void
  onEmailChange: (email: string) => void
  variant: 'modal' | 'page'
  emailInputRef?: RefObject<HTMLInputElement | null>
  /** Show the "Sign in with passkey" button (deployment enabled + browser capable). */
  passkeyAvailable?: boolean
  passkeyPending?: boolean
  onPasskeySignIn?: () => void
}

/**
 * Email input step for sign-in form: a simple email + submit form whose title comes from its host.
 *
 * Page variant: the waitlist's controls, for an auth card.
 * Modal variant: the sign-in modal's controls.
 */
export const SignInEmailStep = ({
  email,
  status,
  errorMessage,
  isValidEmail,
  onSubmit,
  onEmailChange,
  variant,
  emailInputRef,
  passkeyAvailable,
  passkeyPending,
  onPasskeySignIn,
}: SignInEmailStepProps) => {
  const { t } = useLingui()
  const localRef = useRef<HTMLInputElement>(null)
  const inputRef = emailInputRef ?? localRef

  const isLoading = status === 'sending'
  const placeholder = variant === 'modal' ? t`Email address` : t`Email`

  return (
    <form onSubmit={onSubmit} className={variant === 'page' ? 'flex w-full flex-col gap-4' : 'w-full'}>
      {status === 'error' && (
        <p className="text-sm text-destructive">{errorMessage || t`Something went wrong. Please try again.`}</p>
      )}

      {/* Bottom controls — input + button */}
      <div className="flex w-full flex-col gap-4">
        <div className="relative w-full">
          {variant === 'modal' && (
            <Mail className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          )}
          <Input
            ref={inputRef}
            id="email"
            name="email"
            type="email"
            inputMode="email"
            placeholder={placeholder}
            aria-label={placeholder}
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            variant={variant === 'page' ? 'filled' : undefined}
            inputSize={variant === 'page' ? 'xl' : undefined}
            className={
              variant === 'modal'
                ? // Same height token as the submit button below so the pair
                  // reads as one unit; rounded-xl steps down from the modal's
                  // rounded-2xl shell.
                  'h-[var(--touch-height-lg)] rounded-xl pl-12 text-base'
                : 'rounded-xl'
            }
            disabled={isLoading}
            autoComplete="email"
          />
        </div>

        <Button
          type="submit"
          size={variant === 'modal' ? 'lg' : undefined}
          className={variant === 'modal' ? 'w-full rounded-xl' : authButtonClass}
          disabled={isLoading || passkeyPending || !isValidEmail}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <Trans>Sending…</Trans>
            </>
          ) : variant === 'modal' ? (
            <Trans>Send Magic Link</Trans>
          ) : (
            <Trans>Continue</Trans>
          )}
        </Button>

        {passkeyAvailable && onPasskeySignIn && (
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
              size={variant === 'modal' ? 'lg' : undefined}
              className={variant === 'modal' ? 'w-full rounded-xl' : authButtonClass}
              disabled={isLoading || passkeyPending}
              onClick={onPasskeySignIn}
            >
              {passkeyPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Fingerprint className="mr-2 h-4 w-4" />
              )}
              <Trans>Sign in with passkey</Trans>
            </Button>
          </>
        )}
      </div>
    </form>
  )
}
