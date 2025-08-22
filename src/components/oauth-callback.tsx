import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { Loader2 } from 'lucide-react'

export default function OAuthCallback() {
  const navigate = useNavigate()

  useEffect(() => {
    // Parse the URL parameters
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')
    const errorDescription = params.get('error_description')

    // Send message to parent window if this was opened as a popup
    if (window.opener && !window.opener.closed) {
      if (error) {
        window.opener.postMessage(
          {
            type: 'oauth-callback',
            error: errorDescription || error,
          },
          '*',
        )
      } else if (code && state) {
        window.opener.postMessage(
          {
            type: 'oauth-callback',
            code,
            state,
          },
          '*',
        )
      }

      // Close this window after a short delay
      setTimeout(() => {
        window.close()
      }, 1000)
    } else {
      /**
       * defer OAuth redirect to fix the race condition issue
       * @todo try to switch to a sessionStorage envelope or a popup + postMessage flow, so this delay can be removed
       */
      const t = setTimeout(() => {
        // If not a popup, redirect back to integrations page
        navigate('/settings/integrations', {
          state: {
            oauth: { code, state, error: errorDescription || error },
          },
        })
      }, 500)

      return () => clearTimeout(t)
    }
  }, [navigate])

  return (
    <div className="flex flex-1 flex-col items-center justify-center min-h-screen bg-background">
      <div className="text-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
        <h1 className="text-xl font-semibold">Completing Authentication...</h1>
        <p className="text-muted-foreground">Please wait while we complete the authentication process.</p>
      </div>
    </div>
  )
}
