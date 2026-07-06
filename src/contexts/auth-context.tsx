/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts/http-client-context'
import { powersyncCredentialsInvalid } from '@/db/powersync/connector'
import { usePowerSyncCredentialsInvalidListener } from '@/hooks/use-powersync-credentials-invalid-listener'
import { isSsoMode } from '@/lib/auth-mode'
import { clearAuthToken, getAuthToken, onAuthTokenChangedInOtherTab, setAuthToken } from '@/lib/auth-token'
import { getPlatform } from '@/lib/platform'
import { clearCachedSession, getCachedSession, isCachedSessionValid, setCachedSession } from '@/lib/session-cache'
import { anonymousClient, emailOTPClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { consumePendingSsoAnonAlias } from '@/lib/analytics/anonymous-promotion-sso-bridge'
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

  const client = createAuthClient({
    baseURL,
    basePath: '/v1/api/auth',
    plugins: [emailOTPClient(), anonymousClient()],
    fetchOptions: buildFetchOptions(platform),
    // Disable Better Auth's focus/online refetch — Thunderbolt's own cross-tab sync
    // (`onAuthTokenChangedInOtherTab` in src/lib/auth-token.ts) plus the 401 safety net
    // in HttpClient.afterResponse already cover the relevant scenarios without burning
    // rate-limit budget on every tab focus / visibilitychange / online event.
    sessionOptions: {
      refetchOnWindowFocus: false,
      refetchWhenOffline: false,
    },
  })

  hydrateSessionFromCache(client)
  return client
}

/**
 * Seed Better Auth's session atom from the localStorage cache so the app can
 * boot offline for previously-authenticated users.
 *
 * Without this, the gate-protected routes redirect to /waitlist whenever the
 * initial `/get-session` request fails (THU-580). Better Auth's `useAuthQuery`
 * preserves non-null `data` on non-401 errors, so the cached value survives the
 * failing offline fetch and is replaced as soon as a real refetch succeeds
 * (Better Auth's online listener fires this automatically when the network
 * returns).
 *
 * An expired cache is discarded rather than seeded: if the device has been
 * offline past `session.expiresAt`, every subsequent API call would 401
 * anyway, so it's safer to force a fresh `/get-session` than to flash a
 * logged-in UI that will be torn down moments later.
 *
 * Only the seed is synchronous (no lifecycle to clean up). Persisting future
 * updates is wired in {@link subscribeSessionCachePersist} from the provider so
 * the listener is released when the auth client is replaced.
 */
export const hydrateSessionFromCache = (client: ReturnType<typeof createAuthClient>) => {
  if (!getAuthToken()) {
    return
  }
  const cached = getCachedSession()
  if (!cached) {
    return
  }
  if (!isCachedSessionValid(cached)) {
    clearCachedSession()
    return
  }
  const sessionAtom = client.$store.atoms.session
  sessionAtom.set({
    ...sessionAtom.get(),
    data: cached,
    isPending: false,
  })
}

/**
 * Subscribe to the session atom and mirror every authenticated payload back to
 * the localStorage cache so the next offline boot has fresh user data.
 *
 * Returns the nanostores unsubscribe so the caller can release the listener
 * when the auth client is replaced — without this, swapping `cloudUrl` would
 * leak the old client + its refresh manager forever.
 *
 * Only payloads with both `user` and `session` are persisted. Better Auth's
 * refresh manager normalizes empty responses to `null` on its own refetch path
 * but the initial `useAuthQuery` `onSuccess` writes the raw server payload, so
 * `{ user: null, session: null }` can transit the atom — we filter it out here
 * to avoid caching a payload that would only resurrect as a logged-out flash on
 * the next boot. Real sign-out (atom → `null`) is a no-op here on purpose —
 * cache clearing is owned by the 401 handler and `clearLocalData` callers.
 */
export const subscribeSessionCachePersist = (client: ReturnType<typeof createAuthClient>): (() => void) => {
  return client.$store.atoms.session.subscribe((state: { data: Session | null }) => {
    const data = state.data
    if (data?.user && data?.session) {
      setCachedSession(data)
    }
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
    clearCachedSession()
    if (hadToken) {
      // Event name + reason kept in sync with src/db/powersync/connector.ts. Fires on Better Auth's
      // session validation (mount + tab focus), which detects expiry well before PowerSync's
      // credential refresh kicks in — cuts boot-time delay from seconds to milliseconds.
      window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason: 'session_expired' } }))
    }
  },
})

export type AuthClient = ReturnType<typeof createAuthClientInstance>
export type Session = AuthClient['$Infer']['Session']
export type User = Session['user']

type AuthContextType = {
  authClient: AuthClient
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)

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

  // Persist session updates back to the localStorage cache (THU-580). Scoped to
  // an effect so the listener is released when `value` is replaced — otherwise
  // a cloudUrl change would keep the old client's refresh manager alive forever.
  // Skipped when the auth client is an injected test override (no `$store`).
  useEffect(() => {
    const client = value?.authClient
    if (!client?.$store) {
      return
    }
    return subscribeSessionCachePersist(client)
  }, [value])

  // Consume any pending SSO anon-id alias from sessionStorage (written before the SSO redirect
  // by persistForSso()). A ref guard prevents StrictMode's double-invocation from firing alias
  // twice.
  const ssoAliasConsumedRef = useRef(false)
  useEffect(() => {
    if (!value?.authClient || ssoAliasConsumedRef.current) {
      return
    }
    ssoAliasConsumedRef.current = true
    void consumePendingSsoAnonAlias(value.authClient)
  }, [value])

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

  // Cross-tab auth-token sync: another tab's token change propagates via storage events.
  //   - Token rotated (next truthy, changed): reload to pick up the new session identity.
  //   - Token cleared (next falsy, prev truthy): sign-out in another tab → dispatch the same
  //     `powersync_credentials_invalid` event the 401 handler above uses so the existing flow
  //     (sign-in modal + sync teardown) takes over. Event name kept in sync with
  //     `src/db/powersync/connector.ts`.
  useEffect(() => {
    return onAuthTokenChangedInOtherTab((next, prev) => {
      if (next && next !== prev) {
        // Cross-tab rotation may swap in a different user identity; wipe the
        // cache so the reloaded tab doesn't seed the previous user's session
        // under the new token before /get-session lands.
        clearCachedSession()
        window.location.reload()
        return
      }
      if (!next && prev) {
        window.dispatchEvent(new CustomEvent(powersyncCredentialsInvalid, { detail: { reason: 'session_expired' } }))
      }
    })
  }, [])

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
