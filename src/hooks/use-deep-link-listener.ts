import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { getSettings } from '@/dal'
import { isTauri } from '@/lib/platform'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

type DeepLinkHandler = (urls: string[]) => void | Promise<void>

type OAuthCallbackData = {
  code: string | null
  state: string | null
  error: string | null
}

type NavigateTarget = {
  path: string
  oauth: OAuthCallbackData
}

/**
 * Determines the navigation target based on OAuth return context
 * Exported for testing
 */
export const determineNavigationTarget = (
  oauthReturnContext: string | null,
  oauth: OAuthCallbackData,
): NavigateTarget => {
  if (oauthReturnContext?.startsWith('/')) {
    return { path: oauthReturnContext, oauth }
  }

  if (oauthReturnContext === 'integrations') {
    return { path: '/settings/integrations', oauth }
  }

  // Default to integrations page
  return { path: '/settings/integrations', oauth }
}

/**
 * Parses OAuth callback parameters from a deep link URL
 * Exported for testing
 */
export const parseOAuthCallback = (url: URL): OAuthCallbackData | null => {
  if (url.hostname !== 'thunderbolt.io' || !url.pathname.startsWith('/oauth/callback')) {
    return null
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const errorDescription = url.searchParams.get('error_description')

  return {
    code,
    state,
    error: errorDescription || error,
  }
}

type DeepLinkDependencies = {
  isTauri?: typeof isTauri
  getCurrent?: typeof getCurrent
  onOpenUrl?: typeof onOpenUrl
  getSettings?: typeof getSettings
}

/**
 * Hook to listen for deep links (App Links / Universal Links)
 * Handles OAuth callbacks when the app is opened via https://thunderbolt.io/oauth/callback
 *
 * @param handler Optional custom handler for deep links
 * @param dependencies Optional dependencies for testing (uses real implementations by default)
 */
export const useDeepLinkListener = (handler?: DeepLinkHandler, dependencies?: DeepLinkDependencies) => {
  const navigate = useNavigate()
  const location = useLocation()

  // Use injected dependencies or fall back to real implementations
  const {
    isTauri: checkIsTauri = isTauri,
    getCurrent: getCurrentUrls = getCurrent,
    onOpenUrl: listenToOpenUrl = onOpenUrl,
    getSettings: getSettingsData = getSettings,
  } = dependencies || {}

  useEffect(() => {
    if (!checkIsTauri()) return

    let unlisten: (() => void) | null = null

    const setupListener = async () => {
      // Check if app was started via deep link
      const startUrls = await getCurrentUrls()
      if (startUrls && startUrls.length > 0) {
        await handleDeepLinks(startUrls)
      }

      // Listen for deep links while app is running
      unlisten = await listenToOpenUrl(async (urls) => {
        await handleDeepLinks(urls)
      })
    }

    const handleDeepLinks = async (urls: string[]) => {
      for (const urlString of urls) {
        try {
          const url = new URL(urlString)

          // Handle OAuth callback deep links
          const oauthData = parseOAuthCallback(url)
          if (oauthData) {
            // Get the return context from SQLite settings (where mobile flow stores it)
            const settings = await getSettingsData({ oauth_return_context: String })
            const target = determineNavigationTarget(settings.oauthReturnContext, oauthData)

            navigate(target.path, {
              state: { oauth: target.oauth },
              replace: true,
            })
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
  }, [handler, navigate, location.pathname, checkIsTauri, getCurrentUrls, listenToOpenUrl, getSettingsData])
}
