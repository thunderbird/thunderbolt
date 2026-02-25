import { cancel, onUrl, start } from '@fabianlars/tauri-plugin-oauth'
import { openUrl } from '@tauri-apps/plugin-opener'
import { v4 as uuidv4 } from 'uuid'

import {
  type GoogleUserInfo,
  type OAuthProvider,
  type OAuthTokens,
  buildAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
} from './auth'
import { generateCodeChallenge, generateCodeVerifier } from './pkce'

/** Ports pre-registered as redirect URIs in Google/Microsoft OAuth console */
const loopbackPorts = [17421, 17422, 17423]

/** Timeout for user to complete auth in the browser (5 minutes) */
const oauthTimeoutMs = 5 * 60 * 1000

const completionHtml = `<html>
  <head><title>Thunderbolt</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="text-align: center; padding: 2rem;">
      <h2>Authentication Complete</h2>
      <p>You can close this tab and return to Thunderbolt.</p>
    </div>
  </body>
</html>`

/**
 * Starts an OAuth flow using a localhost loopback server and the system browser.
 * Opens the system browser to the OAuth provider's consent screen, waits for
 * the redirect callback on a localhost port, then exchanges the code for tokens.
 *
 * @returns Token + user info on success, null on timeout/cancellation
 * @throws On state mismatch, token exchange failure, or port binding failure
 */
export const startOAuthFlowLoopback = async (
  provider: OAuthProvider,
): Promise<{ tokens: OAuthTokens; userInfo: GoogleUserInfo } | null> => {
  const port = await start({ ports: loopbackPorts, response: completionHtml })
  const redirectUri = `http://localhost:${port}`

  const state = uuidv4()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  const { promise: urlPromise, resolve: resolveUrl } = Promise.withResolvers<string>()

  // Register listener BEFORE opening browser to avoid race condition
  const unlisten = await onUrl((url) => resolveUrl(url))

  // redirectUri param will be accepted once TASK-002 updates auth.ts signatures
  const authUrl = await buildAuthUrl(provider, state, codeChallenge, redirectUri)
  await openUrl(authUrl)

  try {
    const callbackUrl = await Promise.race([
      urlPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OAuth flow timed out')), oauthTimeoutMs)),
    ])

    const url = new URL(callbackUrl)
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
    if (error) throw new Error(error)

    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')

    if (!code || !returnedState) throw new Error('Missing code or state in OAuth callback')
    if (returnedState !== state) throw new Error('OAuth state mismatch')

    // redirectUri param will be accepted once TASK-002 updates auth.ts signatures
    const tokens = await exchangeCodeForTokens(provider, code, codeVerifier, redirectUri)
    const userInfo = await getUserInfo(provider, tokens.access_token)

    return { tokens, userInfo }
  } catch (err) {
    if (err instanceof Error && err.message === 'OAuth flow timed out') return null
    throw err
  } finally {
    unlisten()
    await cancel(port).catch(() => {})
  }
}
