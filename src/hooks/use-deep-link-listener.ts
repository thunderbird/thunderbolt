/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getSettings } from '@/dal'
import type { ReturnContext } from '@/lib/oauth-state'
import { isTauri } from '@/lib/platform'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'

type DeepLinkHandler = (urls: string[]) => void | Promise<void>

type OAuthCallbackData = {
  code: string | null
  state: string | null
  error: string | null
}

type VerifyLinkData = {
  email: string
  otp: string
  challengeToken?: string
}

type NavigateTarget = {
  path: string
  oauth?: OAuthCallbackData
  verifyLink?: VerifyLinkData
}

/**
 * Determines the navigation target based on OAuth return context
 * Exported for testing
 */
export const determineNavigationTarget = (
  oauthReturnContext: ReturnContext | null,
  oauth: OAuthCallbackData,
): NavigateTarget => {
  if (oauthReturnContext?.startsWith('/') && !oauthReturnContext.startsWith('//')) {
    return { path: oauthReturnContext, oauth }
  }

  if (oauthReturnContext === 'onboarding') {
    return { path: '/chats/new', oauth }
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
  if (url.hostname !== 'app.thunderbolt.io' || !url.pathname.startsWith('/oauth/callback')) {
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

/**
 * Parses verify link callback parameters from a deep link URL
 * The URL contains email and otp params which are used to verify via emailOtp sign-in
 * Exported for testing
 */
export const parseVerifyLinkCallback = (url: URL): VerifyLinkData | null => {
  if (url.hostname !== 'app.thunderbolt.io' || !url.pathname.startsWith('/auth/verify')) {
    return null
  }

  const email = url.searchParams.get('email')
  const otp = url.searchParams.get('otp')

  if (!email || !otp) {
    return null
  }

  return { email, otp, challengeToken: url.searchParams.get('challengeToken') ?? undefined }
}

type DeepLinkDependencies = {
  isTauri?: typeof isTauri
  getCurrent?: typeof getCurrent
  onOpenUrl?: typeof onOpenUrl
  getSettings?: typeof getSettings
}

/**
 * Hook to listen for deep links (App Links / Universal Links)
 * Handles OAuth callbacks when the app is opened via https://app.thunderbolt.io/oauth/callback
 *
 * @param handler Optional custom handler for deep links
 * @param dependencies Optional dependencies for testing (uses real implementations by default)
 */
export const useDeepLinkListener = (handler?: DeepLinkHandler, dependencies?: DeepLinkDependencies) => {
  const db = useDatabase()
  const navigate = useNavigate()

  // Use injected dependencies or fall back to real implementations
  const {
    isTauri: checkIsTauri = isTauri,
    getCurrent: getCurrentUrls = getCurrent,
    onOpenUrl: listenToOpenUrl = onOpenUrl,
    getSettings: getSettingsData = getSettings,
  } = dependencies || {}

  useEffect(() => {
    if (!checkIsTauri()) {
      return
    }

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
      const unhandledUrls: string[] = []

      for (const urlString of urls) {
        try {
          const url = new URL(urlString)

          // Handle OAuth callback deep links
          const oauthData = parseOAuthCallback(url)
          if (oauthData) {
            // Get the return context from SQLite settings (where mobile flow stores it)
            const settings = await getSettingsData(db, { oauth_return_context: String })
            const target = determineNavigationTarget(settings.oauthReturnContext as ReturnContext | null, oauthData)

            navigate(target.path, {
              state: { oauth: target.oauth },
              replace: true,
            })
            continue
          }

          // Handle verify link callback deep links (email + OTP from magic link)
          const verifyData = parseVerifyLinkCallback(url)
          if (verifyData) {
            // Navigate to the verify page with email, otp, and challengeToken params
            // The MagicLinkVerify component will use these to call emailOtp sign-in
            const params = new URLSearchParams({ email: verifyData.email, otp: verifyData.otp })
            if (verifyData.challengeToken) {
              params.set('challengeToken', verifyData.challengeToken)
            }
            navigate(`/auth/verify?${params.toString()}`, {
              replace: true,
            })
            continue
          }

          // Collect unhandled URLs for custom handler
          unhandledUrls.push(urlString)
        } catch (err) {
          console.error('Failed to handle deep link:', urlString, err)
        }
      }

      // Call custom handler only for unhandled URLs, once
      if (handler && unhandledUrls.length > 0) {
        await handler(unhandledUrls)
      }
    }

    setupListener()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
