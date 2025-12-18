'use client'

import { useSettings } from '@/hooks/use-settings'
import { getPlatform } from '@/lib/platform'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * Mock user for sync integration testing
 * TODO: Remove once real authentication CORS is resolved
 */
const MOCK_USER = {
  id: 'mock-user-00000000-0000-0000-0000-000000000001',
  email: 'mock-user@thunderbolt.local',
  name: 'Mock User',
  emailVerified: true,
  image: null,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
}

const MOCK_SESSION = {
  id: 'mock-session-00000000-0000-0000-0000-000000000001',
  userId: MOCK_USER.id,
  token: 'mock-token',
  expiresAt: new Date('2099-12-31T23:59:59.999Z'),
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
}

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

/**
 * Create a mock auth client that returns fake session data
 * TODO: Remove once real authentication CORS is resolved
 */
const createMockAuthClient = () => {
  const mockSessionData = {
    data: { user: MOCK_USER, session: MOCK_SESSION },
    isPending: false,
    isRefetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }

  return {
    useSession: () => mockSessionData,
    signOut: () => Promise.resolve({ error: null }),
    // Add other methods as needed for compatibility
  } as unknown as AuthClient
}

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

    // TODO: Replace with real auth client once CORS is resolved
    // const client = createAuthClientInstance(cloudUrl.value)
    const client = createMockAuthClient()
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
