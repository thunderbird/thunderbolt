import { getSettings, updateSettings, deleteSetting } from '@/dal'
import type { OAuthProvider } from './auth'

/**
 * OAuth state stored in sqlite settings
 */
type OAuthState = {
  state: string | null
  provider: OAuthProvider | null
  verifier: string | null
  returnContext: 'onboarding' | 'integrations' | null
}

/**
 * Gets all OAuth state from sqlite settings
 */
export const getOAuthState = async (): Promise<OAuthState> => {
  const settings = await getSettings({
    oauth_state: String,
    oauth_provider: String,
    oauth_verifier: String,
    oauth_return_context: String,
  })

  return {
    state: settings.oauthState,
    provider: settings.oauthProvider as OAuthProvider | null,
    verifier: settings.oauthVerifier,
    returnContext: settings.oauthReturnContext as 'onboarding' | 'integrations' | null,
  }
}

/**
 * Sets OAuth state in sqlite settings
 */
export const setOAuthState = async (state: Partial<OAuthState>): Promise<void> => {
  const settings: Record<string, string | null> = {}

  if (state.state !== undefined) {
    settings.oauth_state = state.state
  }
  if (state.provider !== undefined) {
    settings.oauth_provider = state.provider
  }
  if (state.verifier !== undefined) {
    settings.oauth_verifier = state.verifier
  }
  if (state.returnContext !== undefined) {
    settings.oauth_return_context = state.returnContext
  }

  if (Object.keys(settings).length > 0) {
    await updateSettings(settings)
  }
}

/**
 * Clears OAuth state from sqlite settings
 */
export const clearOAuthState = async (): Promise<void> => {
  await Promise.all([
    deleteSetting('oauth_state'),
    deleteSetting('oauth_provider'),
    deleteSetting('oauth_verifier'),
    deleteSetting('oauth_return_context'),
  ])
}
