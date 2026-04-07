import { usePowerSyncCredentialsInvalidListener } from '@/hooks/use-powersync-credentials-invalid-listener'
import { isOidcMode } from '@/lib/auth-mode'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import { getPlatform } from '@/lib/platform'
import { emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

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

const buildFetchOptions = (platform: string) => ({
  credentials: (isOidcMode() ? 'include' : 'omit') as RequestCredentials,
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
    if (ctx.response?.status === 401) {
      clearAuthToken()
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
