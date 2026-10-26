/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * React context for the universal proxy fetch.
 *
 * The provider builds one `proxyFetch` per `cloudUrl` and memoizes it. Consumers
 * call `useFetch()` from any component or hook to get a `fetch`-shaped function
 * that hides Hosted (web) vs Standalone (Tauri) mode — see `proxy-fetch.ts`.
 *
 * Every request reads the current Cloud Proxy toggle, even from a captured
 * fetch (the Pi harness caches it). `useProxyFetchGetter()` also tracks changes
 * to `cloudUrl` for callers that outlive a render.
 */

import { getAuthToken } from '@/lib/auth-token'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'
import { createProxyFetch, type FetchFn } from './proxy-fetch'

type ProxyFetchContextValue = {
  proxyFetch: FetchFn
  getProxyFetch: () => FetchFn
}

const ProxyFetchContext = createContext<ProxyFetchContextValue | undefined>(undefined)

type ProxyFetchProviderProps = {
  children: ReactNode
  /** Override the proxy fetch in tests so callers don't need a real backend. */
  proxyFetch?: FetchFn
  /** Optional Tauri-detection override for tests. Production callers omit this. */
  isStandalone?: () => boolean
  /** Inject the factory in tests while exercising the provider's real routing options. */
  createFetch?: typeof createProxyFetch
}

/**
 * Mounts a memoized fetch for the current cloudUrl. Web always proxies;
 * Tauri reads proxy_enabled per request, defaulting OFF to native HTTP.
 */
export const ProxyFetchProvider = ({
  children,
  proxyFetch: override,
  isStandalone,
  createFetch = createProxyFetch,
}: ProxyFetchProviderProps) => {
  // `cloudUrl` is sourced from the persisted local-settings-store (seeded from
  // VITE_THUNDERBOLT_CLOUD_URL with a localhost fallback), so it's always a
  // non-null string here.
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const proxyFetch = useMemo(() => {
    if (override) {
      return override
    }
    return createFetch({
      cloudUrl,
      isStandalone,
      getProxyAuthToken: getAuthToken,
    })
  }, [override, cloudUrl, isStandalone, createFetch])

  // Mirror `proxyFetch` into a ref so the stable `getProxyFetch` getter below
  // always returns the *current* fetch. Closures captured by non-React callers
  // (chat-instance.ts customFetch, eval scripts) read through the getter, so a
  // cloudUrl change propagates without recreating the chat instance.
  // Direct ref assignment in render is the React-recommended pattern here
  // (see CLAUDE.md `useEffect` discipline → "Assigning to refs").
  const proxyFetchRef = useRef(proxyFetch)
  proxyFetchRef.current = proxyFetch
  const getProxyFetch = useCallback(() => proxyFetchRef.current, [])

  const value = useMemo(() => ({ proxyFetch, getProxyFetch }), [proxyFetch, getProxyFetch])

  return <ProxyFetchContext.Provider value={value}>{children}</ProxyFetchContext.Provider>
}

/** Returns the proxy fetch for the current cloudUrl. Throws if used outside the provider. */
export const useFetch = (): FetchFn => {
  const context = useContext(ProxyFetchContext)
  if (!context) {
    throw new Error('useFetch must be used within a ProxyFetchProvider')
  }
  return context.proxyFetch
}

/**
 * Returns a stable getter for the current proxy fetch. Use this when the call
 * site lives in a closure that outlives a single render — for example,
 * `aiFetchStreamingResponse` is invoked from the AI SDK's `customFetch`, which
 * is built once when a chat session is created. Calling `useFetch()` there
 * would capture the proxy fetch at chat creation; this getter reads through a
 * ref so cloudUrl changes propagate to existing sessions. The fetch itself
 * reads the current proxy_enabled setting on every request.
 */
export const useProxyFetchGetter = (): (() => FetchFn) => {
  const context = useContext(ProxyFetchContext)
  if (!context) {
    throw new Error('useProxyFetchGetter must be used within a ProxyFetchProvider')
  }
  return context.getProxyFetch
}
