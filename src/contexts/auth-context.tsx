'use client'

import { useSettings } from '@/hooks/use-settings'
import { getPlatform } from '@/lib/platform'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * Create an auth client instance with the given base URL
 * Includes platform header so backend can use deep links for mobile
 */
const createAuthClientInstance = (cloudUrl: string) => {
  // Remove trailing /v1 if present since Better Auth adds /api/auth
  const baseURL = cloudUrl.replace(/\/v1$/, '')
  const platform = getPlatform()

  return createAuthClient({
    baseURL,
    basePath: '/v1/api/auth',
    plugins: [emailOTPClient()],
    fetchOptions: {
      credentials: 'include', // Required for cookies to be sent/received
      headers: {
        'X-Client-Platform': platform,
      },
    },
  })
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
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })

  const value = useMemo(() => {
    if (overrideClient) {
      return { authClient: overrideClient }
    }

    const client = createAuthClientInstance(cloudUrl.value)
    return { authClient: client }
  }, [cloudUrl.value, overrideClient])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context.authClient
}
