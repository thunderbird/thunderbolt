/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SiGithub } from '@icons-pack/react-simple-icons'
import { EyeOff, Loader2, Mail } from 'lucide-react'
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
}

/**
 * Email input step for sign-in form.
 *
 * Page variant includes the title and feature cards.
 * Modal variant omits both (title comes from ResponsiveModalHeader) and stays
 * a simple email + submit form.
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
}: SignInEmailStepProps) => {
  const localRef = useRef<HTMLInputElement>(null)
  const inputRef = emailInputRef ?? localRef

  const isLoading = status === 'sending'

  return (
    // Page variant fills the viewport so the feature cards can center between
    // title and controls; modal variant hugs content for outer centering.
    <form onSubmit={onSubmit} className={variant === 'page' ? 'flex h-full w-full flex-1 flex-col' : 'w-full'}>
      {/* Title — page variant only (modal has its own header) */}
      {variant === 'page' && (
        <div className="text-center">
          <p className="font-sans text-[28px] font-medium leading-normal text-foreground">Early Access Login</p>
        </div>
      )}

      {/* Feature cards — page variant only; the modal stays a simple sign-in form.
          #DCE875 is a one-off accent for these dark-mode feature icons (the
          light-mode emerald/amber tones read as muddy on the dark card); it
          intentionally isn't a theme token — nothing else uses it. */}
      {variant === 'page' && (
        <div className="flex flex-1 items-center">
          <div className="flex w-full flex-col gap-4 rounded-xl bg-secondary px-3 py-4 text-left">
            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 dark:bg-transparent">
                <SiGithub className="size-6 text-emerald-600 dark:text-[#DCE875]" />
              </div>
              <p className="text-base text-muted-foreground">Thunderbolt is open-source</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 dark:bg-transparent">
                <EyeOff className="size-6 text-amber-600 dark:text-[#DCE875]" />
              </div>
              <p className="text-base text-muted-foreground">No logs or training on your data</p>
            </div>
          </div>
        </div>
      )}

      {status === 'error' && (
        <p className="text-sm text-destructive">{errorMessage || 'Something went wrong. Please try again.'}</p>
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
            placeholder={variant === 'modal' ? 'Email address' : 'Email'}
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            className={
              variant === 'modal'
                ? // Same height token as the submit button below so the pair
                  // reads as one unit; rounded-xl steps down from the modal's
                  // rounded-2xl shell.
                  'h-[var(--touch-height-lg)] rounded-xl pl-12 text-base'
                : 'h-[46px] rounded-xl border-border bg-secondary px-3 text-base'
            }
            disabled={isLoading}
            autoComplete="email"
          />
        </div>

        <Button
          type="submit"
          size={variant === 'modal' ? 'lg' : undefined}
          className={
            variant === 'modal'
              ? 'w-full rounded-xl'
              : 'h-[46px] w-full rounded-xl bg-foreground text-background text-base font-medium hover:bg-foreground/90'
          }
          disabled={isLoading || !isValidEmail}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending...
            </>
          ) : variant === 'modal' ? (
            'Send Magic Link'
          ) : (
            'Continue'
          )}
        </Button>
      </div>
    </form>
  )
}
