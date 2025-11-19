import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { isTauri } from '@/lib/platform'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

type DeepLinkHandler = (urls: string[]) => void | Promise<void>

/**
 * Hook to listen for deep links (App Links / Universal Links)
 * Handles OAuth callbacks when the app is opened via https://thunderbolt.io/oauth/callback
 */
export const useDeepLinkListener = (handler?: DeepLinkHandler) => {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | null = null

    const setupListener = async () => {
      // Check if app was started via deep link
      const startUrls = await getCurrent()
      if (startUrls && startUrls.length > 0) {
        await handleDeepLinks(startUrls)
      }

      // Listen for deep links while app is running
      unlisten = await onOpenUrl(async (urls) => {
        await handleDeepLinks(urls)
      })
    }

    const handleDeepLinks = async (urls: string[]) => {
      for (const urlString of urls) {
        try {
          const url = new URL(urlString)

          // Handle OAuth callback deep links
          if (url.hostname === 'thunderbolt.io' && url.pathname.startsWith('/oauth/callback')) {
            const code = url.searchParams.get('code')
            const state = url.searchParams.get('state')
            const error = url.searchParams.get('error')
            const errorDescription = url.searchParams.get('error_description')

            // Navigate to the appropriate route with OAuth data in state
            // Check where we should return to
            const oauthReturnContext = sessionStorage.getItem('oauth_return_context')

            if (oauthReturnContext?.startsWith('/')) {
              navigate(oauthReturnContext, {
                state: {
                  oauth: { code, state, error: errorDescription || error },
                },
                replace: true,
              })
            } else {
              // Default to integrations page
              navigate('/settings/integrations', {
                state: {
                  oauth: { code, state, error: errorDescription || error },
                },
                replace: true,
              })
            }
          }

          // Call custom handler if provided
          if (handler) {
            await handler(urls)
          }
        } catch (err) {
          console.error('Failed to handle deep link:', urlString, err)
        }
      }
    }

    setupListener()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [handler, navigate, location.pathname])
}
