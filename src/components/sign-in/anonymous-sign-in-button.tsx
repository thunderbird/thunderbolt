/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts'
import { useState } from 'react'
import { useNavigate } from 'react-router'

const ANON_AGAIN_ERROR_CODE = 'ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY'

/**
 * One-click button that signs the visitor in anonymously and redirects to the app.
 * Displayed on the waitlist idle screen as a no-commitment entry point.
 */
export const AnonymousSignInButton = () => {
  const authClient = useAuth()
  const navigate = useNavigate()
  const [isPending, setIsPending] = useState(false)

  const handleClick = async () => {
    setIsPending(true)

    try {
      const result = await authClient.signIn.anonymous()

      if (result?.error?.status === 400 && result.error.code === ANON_AGAIN_ERROR_CODE) {
        navigate('/', { replace: true })
        return
      }

      navigate('/', { replace: true })
    } catch (error) {
      const err = error as { status?: number; code?: string }
      if (err?.status === 400 && err?.code === ANON_AGAIN_ERROR_CODE) {
        navigate('/', { replace: true })
        return
      }
      setIsPending(false)
      throw error
    }
  }

  return (
    <Button variant="ghost" disabled={isPending} onClick={handleClick}>
      {isPending ? 'Starting…' : 'Try Thunderbolt without signing up'}
    </Button>
  )
}

export default AnonymousSignInButton
