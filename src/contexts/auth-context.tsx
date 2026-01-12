'use client'

import { useSettings } from '@/hooks/use-settings'
import { getAuthToken, setAuthToken } from '@/lib/auth-token'
import { getPlatform, isMobile } from '@/lib/platform'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * Create an auth client instance with the given base URL
 *
 * On mobile (iOS/Android), uses Bearer token auth since cookies don't persist
 * for the tauri://localhost origin in WKWebView.
 */
const createAuthClientInstance = (cloudUrl: string) => {
  const baseURL = cloudUrl.replace(/\/v1$/, '') // Better Auth adds /api/auth
  const platform = getPlatform()
  const mobile = isMobile()

  return createAuthClient({
    baseURL,
    basePath: '/v1/api/auth',
    plugins: [emailOTPClient()],
    fetchOptions: buildFetchOptions(platform, mobile),
  })
}

const buildFetchOptions = (platform: string, mobile: boolean) => {
  const baseOptions = {
    credentials: (mobile ? 'omit' : 'include') as RequestCredentials,
    headers: { 'X-Client-Platform': platform },
  }

  if (!mobile) {
    return baseOptions
  }

  // Mobile: Use bearer token instead of cookies
  return {
    ...baseOptions,
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
  }
}

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
}

export const AuthProvider = ({ children, authClient: overrideClient }: AuthProviderProps) => {
  const { cloudUrl } = useSettings({ cloud_url: String })

  const value = useMemo(() => {
    if (overrideClient) {
      return { authClient: overrideClient }
    }

    // Don't create auth client until cloudUrl is loaded from settings
    // This prevents Better Auth from making requests to the fallback localhost URL
    if (cloudUrl.isLoading || !cloudUrl.value) {
      return null
    }

    const client = createAuthClientInstance(cloudUrl.value)
    return { authClient: client }
  }, [cloudUrl.value, cloudUrl.isLoading, overrideClient])

  // Wait for auth client to be ready before rendering children
  // This prevents useSession from triggering requests to wrong URL
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
