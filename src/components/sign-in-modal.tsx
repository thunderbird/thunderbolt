'use client'

import { AlertTriangle, Brain, CheckCircle2, Loader2, Mail, RefreshCw } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/contexts'
import { useSettings } from '@/hooks/use-settings'
import { isLocalhostUrl } from '@/lib/utils'

type SignInModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ModalState = 'idle' | 'sending' | 'sent' | 'error'

export const SignInModal = ({ open, onOpenChange }: SignInModalProps) => {
  const authClient = useAuth()
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const isLocalhost = isLocalhostUrl(cloudUrl.value)
  const [email, setEmail] = useState('')
  const [state, setState] = useState<ModalState>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    if (!email.trim()) return

    setState('sending')
    setErrorMessage('')

    const { error } = await authClient.signIn.magicLink({
      email: email.trim(),
      callbackURL: '/',
    })

    if (error) {
      setState('error')
      setErrorMessage(error.message || 'Failed to send magic link')
      return
    }

    setState('sent')
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset state when closing
      setEmail('')
      setState('idle')
      setErrorMessage('')
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {state === 'sent' ? (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{isLocalhost ? 'Check the backend logs' : 'Check your email'}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-6">
              {isLocalhost ? (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-yellow-100 dark:bg-yellow-900/30">
                  <AlertTriangle className="h-8 w-8 text-yellow-600 dark:text-yellow-400" />
                </div>
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                  <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
                </div>
              )}
              <div className="text-center">
                <p className="text-xl font-semibold">{isLocalhost ? 'Check the backend logs' : 'Check your email'}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {isLocalhost ? (
                    <>
                      You appear to be using a{' '}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">localhost</code> backend. Check
                      your backend server logs for the magic link.
                    </>
                  ) : (
                    <>
                      We sent a magic link to <span className="font-medium text-foreground">{email}</span>
                    </>
                  )}
                </p>
              </div>
              <Button variant="outline" className="mt-2" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="space-y-4">
              <div className="text-center">
                <DialogTitle className="text-2xl font-semibold">Unlock more features</DialogTitle>
                <p className="mt-1 text-sm text-muted-foreground">Sign in to get more out of Thunderbolt</p>
              </div>
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15">
                    <Brain className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Premium AI</p>
                    <p className="text-xs text-muted-foreground">Get more power with Anthropic Claude models</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15">
                    <RefreshCw className="h-5 w-5 text-sky-600 dark:text-sky-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Access your chats everywhere</p>
                    <p className="text-xs text-muted-foreground">Encrypted sync between all devices</p>
                  </div>
                </div>
              </div>
              <DialogDescription className="sr-only">Sign up or sign in to access premium features</DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-12 pl-12 text-base"
                  disabled={state === 'sending'}
                  autoComplete="email"
                  autoFocus
                />
              </div>

              {state === 'error' && (
                <p className="text-sm text-destructive">{errorMessage || 'Something went wrong. Please try again.'}</p>
              )}

              <Button type="submit" className="w-full" disabled={state === 'sending' || !email.trim()}>
                {state === 'sending' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Send Magic Link'
                )}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                No password needed. We&apos;ll send you a secure link to sign in.
              </p>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
