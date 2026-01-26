import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Brain, Loader2, Mail, RefreshCw } from 'lucide-react'
import { useRef, type FormEvent, type RefObject } from 'react'

type SignInEmailStepProps = {
  email: string
  status: 'idle' | 'sending' | 'error'
  errorMessage: string
  onSubmit: (e: FormEvent) => void
  onEmailChange: (email: string) => void
  variant: 'modal' | 'page'
  emailInputRef?: RefObject<HTMLInputElement | null>
}

/**
 * Email input step for sign-in form.
 * Shows feature cards and email input with submit button.
 */
export const SignInEmailStep = ({
  email,
  status,
  errorMessage,
  onSubmit,
  onEmailChange,
  variant,
  emailInputRef,
}: SignInEmailStepProps) => {
  const localRef = useRef<HTMLInputElement>(null)
  const inputRef = emailInputRef ?? localRef

  const isLoading = status === 'sending'

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
      {/* Feature cards */}
      <div className="mb-4 flex w-full flex-col gap-4 rounded-lg bg-muted/50 p-4 text-left">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15">
            <RefreshCw className="h-5 w-5 text-sky-600 dark:text-sky-400" />
          </div>
          <p className="text-sm">Sync chats between devices</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15">
            <Brain className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <p className="text-sm">Access more powerful AI models</p>
        </div>
      </div>

      {/* Email input */}
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

      {status === 'error' && (
        <p className="text-sm text-destructive">{errorMessage || 'Something went wrong. Please try again.'}</p>
      )}

      {variant === 'modal' && (
        <p className="text-center text-xs text-muted-foreground">We&apos;ll send you a secure link to sign in.</p>
      )}

      {/* Submit button */}
      <Button
        type="submit"
        className={variant === 'modal' ? 'w-full' : 'h-[46px] w-full rounded-xl text-base font-medium'}
        disabled={isLoading || !email.trim()}
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
    </form>
  )
}
