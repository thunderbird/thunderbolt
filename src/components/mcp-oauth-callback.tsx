import Loading from '@/loading'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'

/**
 * Handles the OAuth callback redirect for MCP servers.
 *
 * Same-tab redirect path (web): extracts code from URL, navigates to
 * /settings/mcp-servers with the code in location.state — matching the
 * integration OAuth pattern (see oauth-callback.tsx).
 *
 * Popup path (desktop/fallback): posts the code back via postMessage.
 */
const McpOAuthCallback = () => {
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error')
    const errorDescription = params.get('error_description')

    // Popup path: send code back to opener (desktop flow)
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        error
          ? { type: 'mcp-oauth-callback', error: errorDescription || error }
          : { type: 'mcp-oauth-callback', code, state },
        window.location.origin,
      )
      setTimeout(() => window.close(), 500)
      return
    }

    // Same-tab redirect path (web): navigate to MCP servers with code
    const t = setTimeout(() => {
      navigate('/settings/mcp-servers', {
        state: { mcpOauth: { code, state, error: errorDescription || error } },
        replace: true,
      })
    }, 300)

    return () => clearTimeout(t)
  }, [navigate])

  return (
    <div className="flex flex-1 flex-col items-center justify-center min-h-screen bg-background">
      <div className="text-center space-y-4">
        <Loading />
        <p className="text-sm text-muted-foreground">Completing authorization...</p>
      </div>
    </div>
  )
}

export default McpOAuthCallback
