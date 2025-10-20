import { useState } from 'react'
import { updateSetting } from '@/dal'
import { isTauri } from '@/lib/platform'
import { startOAuthFlow, type OAuthProvider } from '@/lib/auth'
import { startOAuthFlowWebview } from '@/lib/oauth-webview'

type UseOAuthConnectOptions = {
  onSuccess?: () => void
  onError?: (error: Error) => void
  setPreferredName?: boolean
}

type UseOAuthConnectResult = {
  connect: (provider: OAuthProvider) => Promise<void>
  error: string | null
  clearError: () => void
}

/**
 * Handles OAuth connection flow for any provider.
 * Opens auth window, exchanges tokens, saves credentials, and enables integration.
 */
export const useOAuthConnect = (options: UseOAuthConnectOptions = {}): UseOAuthConnectResult => {
  const { onSuccess, onError, setPreferredName = false } = options
  const [error, setError] = useState<string | null>(null)

  const connect = async (provider: OAuthProvider) => {
    setError(null)

    try {
      const result = isTauri() ? await startOAuthFlowWebview(provider) : await startOAuthFlow(provider)

      if (!result) return

      const { tokens, userInfo } = result

      const credentials = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || '',
        expires_at: Date.now() + tokens.expires_in * 1000,
        profile: {
          email: userInfo.email,
          name: userInfo.name,
        },
      }

      await updateSetting(`integrations_${provider}_credentials`, JSON.stringify(credentials))
      await updateSetting(`integrations_${provider}_is_enabled`, 'true')

      if (setPreferredName && userInfo.name) {
        await updateSetting('preferred_name', userInfo.name)
      }

      onSuccess?.()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to complete authentication'
      setError(message)
      onError?.(e instanceof Error ? e : new Error(message))
    }
  }

  const clearError = () => setError(null)

  return { connect, error, clearError }
}
