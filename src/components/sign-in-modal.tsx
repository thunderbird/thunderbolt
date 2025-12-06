'use client'

import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { AlertTriangle, ArrowLeft, Brain, Check, CheckCircle2, Loader2, Mail, RefreshCw } from 'lucide-react'
import { useRef } from 'react'

import { ActionFeedbackButton } from '@/components/ui/action-feedback-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { useAuth } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
import { isLocalhostUrl } from '@/lib/utils'
import { useSignInModalState } from './use-sign-in-modal-state'

type SignInModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const SignInModal = ({ open, onOpenChange }: SignInModalProps) => {
  const authClient = useAuth()
  const { cloudUrl, preferredName } = useSettings({ cloud_url: 'http://localhost:8000/v1', preferred_name: '' })
  const isLocalhost = isLocalhostUrl(cloudUrl.value)
  const displayName = preferredName.value as string
  const emailInputRef = useRef<HTMLInputElement>(null)

  const { state, actions } = useSignInModalState({
    authClient,
    onClose: () => onOpenChange(false),
  })

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      actions.handleOpenChange(false)
    }
    onOpenChange(newOpen)
  }

  const handleOpenAutoFocus = (event: Event) => {
    // Prevent default Radix focus behavior and explicitly focus the email input
    event.preventDefault()
    emailInputRef.current?.focus()
  }

  // Success state
  if (state.status === 'success') {
    return (
      <ResponsiveModal open={open} onOpenChange={handleOpenChange}>
        <ResponsiveModalHeader className="sr-only">
          <ResponsiveModalTitle>Welcome</ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <ResponsiveModalContent centered className="items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
            <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <h2 className="mt-4 text-xl font-semibold">{displayName ? `Welcome, ${displayName}!` : 'Welcome!'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">You're now signed in.</p>
        </ResponsiveModalContent>

        <ResponsiveModalFooter>
          <Button onClick={() => handleOpenChange(false)} className="w-full">
            Continue
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModal>
    )
  }

  // OTP entry state
  if (state.status === 'sent' || state.status === 'verifying') {
    return (
      <ResponsiveModal open={open} onOpenChange={handleOpenChange}>
        <ResponsiveModalHeader>
          <button
            type="button"
            onClick={actions.goBack}
            className="absolute left-4 top-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full hover:bg-muted transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <ResponsiveModalTitle className="sr-only">
            {isLocalhost ? 'Check the backend logs' : 'Enter your code'}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>

        <ResponsiveModalContent centered className="items-center text-center gap-4">
          {isLocalhost ? (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/30">
              <AlertTriangle className="h-8 w-8 text-yellow-600 dark:text-yellow-400" />
            </div>
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <Mail className="h-8 w-8 text-primary" />
            </div>
          )}

          <div>
            <p className="text-xl font-semibold">{isLocalhost ? 'Check the backend logs' : 'Check your email'}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {isLocalhost ? (
                <>
                  You appear to be using a{' '}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">localhost</code> backend. Check your
                  backend server logs for the code or magic link.
                </>
              ) : (
                <>
                  We sent a code to <span className="font-medium text-foreground">{state.email}</span>
                </>
              )}
            </p>
          </div>

          <div className="flex flex-col items-center gap-3 pt-2">
            <p className="text-sm text-muted-foreground">Or enter the 6-digit code</p>
            <InputOTP
              maxLength={6}
              pattern={REGEXP_ONLY_DIGITS}
              value={state.otp}
              onChange={actions.setOtp}
              onComplete={actions.handleOtpComplete}
              disabled={state.status === 'verifying'}
              autoFocus
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>

            {state.status === 'verifying' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying...
              </div>
            )}

            {state.errorMessage && <p className="text-sm text-destructive">{state.errorMessage}</p>}

            <ActionFeedbackButton
              variant="ghost"
              size="sm"
              onClick={actions.handleResend}
              disabled={state.status === 'verifying'}
              className="text-muted-foreground hover:text-foreground"
              successContent={
                <>
                  <Check className="mr-2 h-4 w-4" />
                  Sent
                </>
              }
            >
              Resend Email
            </ActionFeedbackButton>

            {!isLocalhost && <p className="text-xs text-muted-foreground">Or click the magic link in your email</p>}
          </div>
        </ResponsiveModalContent>

        <ResponsiveModalFooter>
          <Button variant="outline" className="w-full" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
        </ResponsiveModalFooter>
      </ResponsiveModal>
    )
  }

  // Initial email entry state
  return (
    <ResponsiveModal open={open} onOpenChange={handleOpenChange} onOpenAutoFocus={handleOpenAutoFocus}>
      <ResponsiveModalHeader className="text-center">
        <ResponsiveModalTitle className="text-2xl font-semibold">Unlock more features</ResponsiveModalTitle>
        <ResponsiveModalDescription>Sign in to get more out of Thunderbolt</ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <form onSubmit={actions.handleSubmit} className="contents">
        <ResponsiveModalContent centered className="gap-4">
          <div className="flex flex-col gap-4 text-left w-full rounded-lg bg-muted/50 p-4 mb-4">
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

          <div className="relative w-full">
            <Mail className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={emailInputRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              placeholder="Email address"
              value={state.email}
              onChange={(e) => actions.setEmail(e.target.value)}
              className="h-12 pl-12 text-base"
              disabled={state.status === 'sending'}
              autoComplete="email"
            />
          </div>

          {state.status === 'error' && (
            <p className="text-sm text-destructive">
              {state.errorMessage || 'Something went wrong. Please try again.'}
            </p>
          )}

          <p className="text-center text-xs text-muted-foreground">We&apos;ll send you a secure link to sign in.</p>
        </ResponsiveModalContent>

        <ResponsiveModalFooter>
          <Button type="submit" className="w-full" disabled={state.status === 'sending' || !state.email.trim()}>
            {state.status === 'sending' ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              'Send Magic Link'
            )}
          </Button>
        </ResponsiveModalFooter>
      </form>
    </ResponsiveModal>
  )
}
