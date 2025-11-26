'use client'

import { CheckCircle2, Loader2, Mail, Sparkles } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authClient } from '@/lib/auth-client'

type SignInModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ModalState = 'idle' | 'sending' | 'sent' | 'error'

export const SignInModal = ({ open, onOpenChange }: SignInModalProps) => {
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
        <DialogHeader>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500">
            <Sparkles className="h-6 w-6 text-white" />
          </div>
          <DialogTitle className="text-center text-xl">Unlock More Features</DialogTitle>
          <DialogDescription className="text-center">
            Sign in with your email to access premium features, sync across devices, and more.
          </DialogDescription>
        </DialogHeader>

        {state === 'sent' ? (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
            </div>
            <div className="text-center">
              <p className="font-medium">Check your email</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a magic link to <span className="font-medium">{email}</span>
              </p>
              <p className="mt-2 text-xs text-muted-foreground">The link expires in 5 minutes</p>
            </div>
            <Button variant="outline" className="mt-2" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                  disabled={state === 'sending'}
                  autoComplete="email"
                  autoFocus
                />
              </div>
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
        )}
      </DialogContent>
    </Dialog>
  )
}
