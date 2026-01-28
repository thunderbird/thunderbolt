import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Brain, Loader2, Mail, RefreshCw } from 'lucide-react'
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
 * Shows feature cards and email input with submit button.
 *
 * Page variant includes the title and uses vertical spacing (justify-between).
 * Modal variant omits the title (provided by ResponsiveModalHeader).
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
    <form onSubmit={onSubmit} className="flex h-full w-full flex-col">
      {/* Title — page variant only (modal has its own header) */}
      {variant === 'page' && (
        <div className="text-center">
          <p className="font-sans text-[28px] font-medium leading-normal text-foreground">Sign Up or Log In</p>
        </div>
      )}

      {/* Feature cards — centered vertically via my-auto */}
      <div className="my-auto flex w-full flex-col gap-4 rounded-xl bg-secondary px-3 py-4 text-left">
        <div className="flex items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 dark:bg-transparent">
            <RefreshCw className="size-6 text-sky-600 dark:text-[#DCE875]" />
          </div>
          <p className="text-base text-muted-foreground">Sync chats between devices</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 dark:bg-transparent">
            <Brain className="size-6 text-violet-600 dark:text-[#DCE875]" />
          </div>
          <p className="text-base text-muted-foreground">Access more powerful AI models</p>
        </div>
      </div>

      {status === 'error' && (
        <p className="text-sm text-destructive">{errorMessage || 'Something went wrong. Please try again.'}</p>
      )}

      {/* Bottom controls — input + button */}
      <div className="flex flex-col gap-4">
        {variant === 'modal' && (
          <p className="text-center text-xs text-muted-foreground">We&apos;ll send you a secure link to sign in.</p>
        )}

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
                ? 'h-12 pl-12 text-base'
                : 'h-[46px] rounded-xl border-border bg-secondary px-3 text-base'
            }
            disabled={isLoading}
            autoComplete="email"
          />
        </div>

        <Button
          type="submit"
          className={
            variant === 'modal'
              ? 'w-full'
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
