/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts/http-client-context'
import { usePowerSyncCredentialsInvalidListener } from '@/hooks/use-powersync-credentials-invalid-listener'
import { isSsoMode } from '@/lib/auth-mode'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import { getPlatform } from '@/lib/platform'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'

/**
 * Create an auth client instance with the given base URL
 *
 * Uses Bearer token authentication for all platforms, storing tokens
 * in the settings database for persistence across app restarts.
 */
const createAuthClientInstance = (cloudUrl: string) => {
  const baseURL = cloudUrl.replace(/\/v1$/, '') // Better Auth adds /api/auth
  const platform = getPlatform()

  return createAuthClient({
    baseURL,
    basePath: '/v1/api/auth',
    plugins: [emailOTPClient()],
    fetchOptions: buildFetchOptions(platform),
  })
}

export const buildFetchOptions = (platform: string) => ({
  credentials: (isSsoMode() ? 'include' : 'omit') as RequestCredentials,
  headers: { 'X-Client-Platform': platform },
  auth: {
    type: 'Bearer' as const,
    token: () => getAuthToken() ?? '',
  },
  onSuccess: (ctx: { response: Response }) => {
    const token = ctx.response.headers.get('set-auth-token')
    if (token) {
      setAuthToken(token)
    }
  },
  onError: (ctx: { response: Response }) => {
    if (ctx.response?.status !== 401) {
      return
    }
    // Capture token presence BEFORE clearing — only a 401 against an existing token signals a real
    // session expiry. A 401 from sign-in/OTP-verify (no stored token) must NOT trigger the modal.
    const hadToken = Boolean(getAuthToken())
    clearAuthToken()
    if (hadToken) {
      // Event name + reason kept in sync with src/db/powersync/connector.ts. Fires on Better Auth's
      // session validation (mount + tab focus), which detects expiry well before PowerSync's
      // credential refresh kicks in — cuts boot-time delay from seconds to milliseconds.
      window.dispatchEvent(new CustomEvent('powersync_credentials_invalid', { detail: { reason: 'session_expired' } }))
    }
  },
})

export type AuthClient = ReturnType<typeof createAuthClientInstance>
export type Session = AuthClient['$Infer']['Session']
export type User = Session['user']

type AuthContextType = {
  authClient: AuthClient
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

type AuthProviderProps = {
  children: ReactNode
  /** Override auth client for testing */
  authClient?: AuthClient
  cloudUrl?: string
}

export const AuthProvider = ({ children, cloudUrl, authClient: overrideClient }: AuthProviderProps) => {
  // Run the credentials-invalid listener at the top of AuthProvider so it mounts early —
  // before any children that depend on auth. When the user deletes their account elsewhere
  // or a device is revoked, this listener triggers a full reset and reload.
  usePowerSyncCredentialsInvalidListener()

  const value = useMemo(() => {
    if (overrideClient) {
      return { authClient: overrideClient }
    }

    if (!cloudUrl) {
      return null
    }

    const client = createAuthClientInstance(cloudUrl)
    return { authClient: client }
  }, [cloudUrl, overrideClient])

  // Validate the stored token on mount via HttpClient — its afterResponse hook fires
  // session_expired on the first 401. Avoids Better Auth's auth client to sidestep its
  // internal retry path. Ref guards against StrictMode's double mount.
  const httpClient = useHttpClient()
  const sessionCheckFiredRef = useRef(false)
  useEffect(() => {
    if (!value?.authClient || sessionCheckFiredRef.current) {
      return
    }
    if (!getAuthToken()) {
      return
    }
    sessionCheckFiredRef.current = true
    void httpClient.get('api/auth/get-session').catch(() => {
      // 401 is handled by the afterResponse hook; other failures aren't session signals.
    })
  }, [value, httpClient])

  if (!value) {
    return null
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context.authClient
}
