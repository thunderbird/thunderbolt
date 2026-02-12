'use client'

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAuth } from '@/contexts'
import { getOtpErrorMessage } from '@/lib/otp-error-messages'
import { useSettings } from '@/hooks/use-settings'

type VerifyState = { status: 'verifying' } | { status: 'success' } | { status: 'error'; message: string }

/**
 * Magic link verification page
 * Handles the callback when user clicks the magic link from email
 * The URL contains email and otp params which we use to verify via the emailOtp sign-in endpoint
 */
export const MagicLinkVerify = () => {
  const authClient = useAuth()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [state, setState] = useState<VerifyState>({ status: 'verifying' })

  const { preferredName } = useSettings({ preferred_name: '' })
  const displayName = preferredName.value as string

  // Get refetch function to update session cache after verification
  const { refetch: refetchSession } = authClient.useSession()

  const email = searchParams.get('email')
  const otp = searchParams.get('otp')

  useEffect(() => {
    const verify = async () => {
      if (!email || !otp) {
        setState({ status: 'error', message: 'Invalid verification link. Please request a new one.' })
        return
      }

      try {
        // Use the standard emailOtp sign-in endpoint
        // This is what Better Auth provides - no custom endpoint needed
        const result = await authClient.signIn.emailOtp({
          email,
          otp,
        })

        if (result.error) {
          setState({ status: 'error', message: getOtpErrorMessage(result.error, 'link') })
          return
        }

        // Refetch session to update the auth client cache
        // This ensures the sidebar and other components see the new session immediately
        await refetchSession()

        setState({ status: 'success' })
      } catch {
        setState({ status: 'error', message: 'Something went wrong. Please try again.' })
      }
    }

    verify()
  }, [email, otp, authClient, refetchSession])

  const handleContinue = () => {
    navigate('/', { replace: true })
  }

  const handleClose = () => {
    navigate('/', { replace: true })
  }

  // Modal is always open on this route - can only close via buttons
  const canClose = state.status !== 'verifying'

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open && canClose) {
          handleClose()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onPointerDownOutside={(e) => {
          if (!canClose) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (!canClose) e.preventDefault()
        }}
      >
        {state.status === 'verifying' && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500">
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              </div>
              <DialogTitle className="text-center text-xl">Signing you in...</DialogTitle>
              <DialogDescription className="text-center">Please wait while we verify your link.</DialogDescription>
            </DialogHeader>
          </>
        )}

        {state.status === 'success' && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <DialogTitle className="text-center text-xl">
                {displayName ? `Welcome, ${displayName}` : 'Welcome!'}
              </DialogTitle>
              <DialogDescription className="text-center">You're now signed in.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center py-4">
              <Button onClick={handleContinue} className="w-full">
                Continue
              </Button>
            </div>
          </>
        )}

        {state.status === 'error' && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
              </div>
              <DialogTitle className="text-center text-xl">Verification Failed</DialogTitle>
              <DialogDescription className="text-center">{state.message}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center py-4">
              <Button variant="outline" onClick={handleClose} className="w-full">
                Close
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default MagicLinkVerify
