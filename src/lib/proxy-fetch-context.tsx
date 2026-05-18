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
 * Non-React callers (e.g. `src/ai/fetch.ts`) cannot use this hook directly; they
 * should construct or cache their own `proxyFetch` via `createProxyFetch`. Note
 * that the module-scoped cache in `src/ai/fetch.ts` is independent of this
 * context — the two are not coordinated.
 */

import { defaultSettingCloudUrl } from '@/defaults/settings'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { useSettings } from '@/hooks/use-settings'
import { isTauri } from '@/lib/platform'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { computeEffectiveProxyEnabled, createProxyFetch } from './proxy-fetch'

type ProxyFetchContextValue = {
  proxyFetch: typeof fetch
}

const ProxyFetchContext = createContext<ProxyFetchContextValue | undefined>(undefined)

type ProxyFetchProviderProps = {
  children: ReactNode
  /** Override the proxy fetch in tests so callers don't need a real backend. */
  proxyFetch?: typeof fetch
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
  // `useSettings` applies the default when the stored value is null, so `cloudUrl.value`
  // is always a non-null string here — no extra `??` chain needed.
  const { cloudUrl } = useSettings({ cloud_url: defaultSettingCloudUrl.value ?? 'http://localhost:8000/v1' })
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
      cloudUrl: cloudUrl.value,
      isStandalone,
      getProxyEnabled: () => effectiveProxyEnabled,
    })
  }, [override, cloudUrl.value, effectiveProxyEnabled, isStandalone])

  return <ProxyFetchContext.Provider value={{ proxyFetch }}>{children}</ProxyFetchContext.Provider>
}

/** Returns the proxy fetch for the current cloudUrl. Throws if used outside the provider. */
export const useFetch = (): typeof fetch => {
  const context = useContext(ProxyFetchContext)
  if (!context) {
    throw new Error('useFetch must be used within a ProxyFetchProvider')
  }
  return context.proxyFetch
}
