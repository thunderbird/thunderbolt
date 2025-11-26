'use client'

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useSettings } from '@/hooks/use-settings'
import { type User } from '@/lib/auth-client'

type VerifyState = 'verifying' | 'success' | 'error'

/**
 * Get the auth API base URL
 */
const getAuthApiURL = () => {
  const cloudUrl = import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1'
  return cloudUrl.replace(/\/v1$/, '') + '/v1/api/auth'
}

/**
 * Magic link verification page
 * Handles the callback when user clicks magic link from email
 * Shows a modal with verification progress and result
 */
export const MagicLinkVerify = () => {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [state, setState] = useState<VerifyState>('verifying')
  const [errorMessage, setErrorMessage] = useState('')
  const [user, setUser] = useState<User | null>(null)

  const { preferredName } = useSettings({ preferred_name: '' })
  const displayName = preferredName.value as string

  const token = searchParams.get('token')

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setState('error')
        setErrorMessage('No verification token found')
        return
      }

      try {
        // Call the backend verify endpoint directly
        // This sets the session cookie and returns user data
        const verifyUrl = `${getAuthApiURL()}/magic-link/verify?token=${encodeURIComponent(token)}`

        const response = await fetch(verifyUrl, {
          method: 'GET',
          credentials: 'include', // Important: include cookies for session
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          setState('error')
          setErrorMessage(errorData.message || 'Verification failed. The link may have expired.')
          return
        }

        const data = await response.json()

        if (data?.user) {
          setUser(data.user)
        }
        setState('success')
      } catch {
        setState('error')
        setErrorMessage('Unable to connect to the server. Please check your connection and try again.')
      }
    }

    verifyToken()
  }, [token])

  const handleContinue = () => {
    navigate('/', { replace: true })
  }

  const handleClose = () => {
    navigate('/', { replace: true })
  }

  // Modal is always open on this route - can only close via buttons
  const canClose = state !== 'verifying'

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
        {state === 'verifying' && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500">
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              </div>
              <DialogTitle className="text-center text-xl">Signing you in...</DialogTitle>
              <DialogDescription className="text-center">
                Please wait while we verify your magic link.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center py-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Verifying...
              </div>
            </div>
          </>
        )}

        {state === 'success' && (
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

        {state === 'error' && (
          <>
            <DialogHeader>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400" />
              </div>
              <DialogTitle className="text-center text-xl">Verification Failed</DialogTitle>
              <DialogDescription className="text-center">
                The link may have expired. Please request a new one.
              </DialogDescription>
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
