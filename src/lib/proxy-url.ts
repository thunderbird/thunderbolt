import { useSettings } from '@/hooks/use-settings'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { isTauri } from '@/lib/platform'

export type ProxyUrlContext = {
  cloudUrl: string
  proxyEnabled: boolean
  /** Test-only override — when set, bypasses the runtime isTauri() probe. */
  isTauriPlatform?: boolean
}

/**
 * Builds a proxy URL for a target HTTP resource.
 *
 * Web always proxies (browser CORS forces it). Tauri/mobile proxies only when
 * the user opts in via `proxy_enabled`. The single if/else below is the only
 * decision point in the codebase that chooses between proxied and direct URLs;
 * call sites must pass context, never branch on it. Removable in one step:
 * delete this file + the Settings UI row + the localStorage key.
 *
 * @param target Absolute upstream URL to proxy.
 * @param ctx    Cloud URL, current proxy_enabled value, optional platform override for tests.
 * @returns The URL the caller should hit (proxied or pass-through).
 */
export const getProxyUrl = (target: string, ctx: ProxyUrlContext): string => {
  const onTauri = ctx.isTauriPlatform ?? isTauri()
  if (onTauri && !ctx.proxyEnabled) {
    return target
  }
  return `${ctx.cloudUrl}/proxy/${encodeURIComponent(target)}`
}

/**
 * React hook that wires `getProxyUrl` to the live `cloud_url` setting and the
 * device-local `proxy_enabled` localStorage flag. Returns a function the caller
 * invokes per request — recreated each render, like `t` from i18n libraries.
 *
 * @param override Optional `{ isTauriPlatform }` override for unit tests; production callers pass nothing.
 */
export const useProxyUrl = (override?: { isTauriPlatform?: boolean }): ((target: string) => string) => {
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const [proxyEnabledStr] = useLocalStorage('proxy_enabled', 'false')
  return (target) =>
    getProxyUrl(target, {
      cloudUrl: cloudUrl.value,
      proxyEnabled: proxyEnabledStr === 'true',
      isTauriPlatform: override?.isTauriPlatform,
    })
}
