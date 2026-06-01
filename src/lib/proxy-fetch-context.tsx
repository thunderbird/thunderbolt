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
 * Non-React callers (e.g. `aiFetchStreamingResponse`) live behind closures (the
 * AI SDK's `customFetch`, the chat instance) that capture context values at
 * creation time, so `useFetch()`'s memoized value would freeze them to whatever
 * the proxy looked like when the chat was opened. `useProxyFetchGetter()`
 * returns a stable getter backed by a ref — call it at invocation time to
 * always read the current proxy fetch, even after `cloud_url` or the
 * `proxy_enabled` toggle changes.
 */

import { useLocalStorage } from '@/hooks/use-local-storage'
import { getAuthToken } from '@/lib/auth-token'
import { isTauri } from '@/lib/platform'
import { useActiveCloudUrl } from '@/stores/trust-domain-registry'
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'
import { computeEffectiveProxyEnabled, createProxyFetch, type FetchFn } from './proxy-fetch'

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
}

/**
 * Mounts a memoized `proxyFetch` for the current `cloudUrl` setting and the
 * `proxy_enabled` localStorage flag. The fetch is re-created only when those
 * inputs change (`useMemo`, no `useEffect` — this is derived state, see
 * CLAUDE.md `useEffect` discipline).
 *
 * Effective proxy behaviour:
 *   - Web: always proxied (browser CORS forces it; the toggle is UI-disabled).
 *   - Tauri: respects the user toggle; default OFF means upstream-direct.
 */
export const ProxyFetchProvider = ({ children, proxyFetch: override, isStandalone }: ProxyFetchProviderProps) => {
  // `cloudUrl` is sourced from the active trust-domain entry in the registry. In v1
  // server-mode boots this is always a non-empty string by the time the provider mounts
  // (boot Step 0 resolves it). The `?? ''` keeps the type a `string` for standalone
  // trust domains where there is no server — proxy fetch is unused there.
  const cloudUrl = useActiveCloudUrl() ?? ''
  const [proxyEnabledStr] = useLocalStorage('proxy_enabled', 'false')

  // Web always proxies (toggle is UI-disabled). Tauri respects the stored value.
  const onTauri = (isStandalone ?? isTauri)()
  const effectiveProxyEnabled = computeEffectiveProxyEnabled(
    () => onTauri,
    () => proxyEnabledStr,
  )

  const proxyFetch = useMemo(() => {
    if (override) {
      return override
    }
    return createProxyFetch({
      cloudUrl,
      isStandalone,
      getProxyEnabled: () => effectiveProxyEnabled,
      getProxyAuthToken: getAuthToken,
    })
  }, [override, cloudUrl, effectiveProxyEnabled, isStandalone])

  // Mirror `proxyFetch` into a ref so the stable `getProxyFetch` getter below
  // always returns the *current* fetch. Closures captured by non-React callers
  // (chat-instance.ts customFetch, eval scripts) read through the getter, so a
  // cloudUrl/toggle change propagates without recreating the chat instance.
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
 * ref so settings changes propagate to in-flight sessions.
 */
export const useProxyFetchGetter = (): (() => FetchFn) => {
  const context = useContext(ProxyFetchContext)
  if (!context) {
    throw new Error('useProxyFetchGetter must be used within a ProxyFetchProvider')
  }
  return context.getProxyFetch
}
