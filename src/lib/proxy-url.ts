/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSettings } from '@/hooks/use-settings'
import { useLocalStorage } from '@/hooks/use-local-storage'
import { isTauri } from '@/lib/platform'
import { useMediaJwt } from '@/lib/use-media-jwt'

export type ProxyUrlContext = {
  cloudUrl: string
  proxyEnabled: boolean
  /** JWT minted by the Better Auth JWT plugin. Required when the request will be
   *  routed through the proxy AND the caller cannot attach an Authorization
   *  header (browser `<img>` / `<link>` subresource loads). When the JWT is not
   *  yet available, `getProxyUrl` returns `null` and the caller is expected to
   *  render a fallback (skeleton / letter badge) until it resolves. */
  mediaJwt?: string | null
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
 * Returns `null` only when proxying is required but the media JWT has not yet
 * been minted. Callers MUST handle this — typically by suppressing the `<img>`
 * render until the JWT resolves.
 *
 * @param target Absolute upstream URL to proxy.
 * @param ctx    Cloud URL, current proxy_enabled value, optional JWT, optional platform override for tests.
 */
export const getProxyUrl = (target: string, ctx: ProxyUrlContext): string | null => {
  const onTauri = ctx.isTauriPlatform ?? isTauri()
  if (onTauri && !ctx.proxyEnabled) {
    return target
  }
  if (!ctx.mediaJwt) {
    return null
  }
  return `${ctx.cloudUrl}/proxy/${encodeURIComponent(target)}?token=${encodeURIComponent(ctx.mediaJwt)}`
}

/**
 * React hook that wires `getProxyUrl` to the live `cloud_url` setting, the
 * device-local `proxy_enabled` localStorage flag, and the cached media JWT.
 * Returns a function the caller invokes per request — recreated each render,
 * like `t` from i18n libraries.
 *
 * The returned function returns `string | null`:
 *   - `string` — proxied (or pass-through, on Tauri with the toggle off).
 *   - `null` — JWT not yet minted; caller should render a fallback.
 *
 * @param override Optional `{ isTauriPlatform }` override for unit tests; production callers pass nothing.
 */
export const useProxyUrl = (override?: { isTauriPlatform?: boolean }): ((target: string) => string | null) => {
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const [proxyEnabledStr] = useLocalStorage('proxy_enabled', 'false')
  const mediaJwt = useMediaJwt()
  return (target) =>
    getProxyUrl(target, {
      cloudUrl: cloudUrl.value,
      proxyEnabled: proxyEnabledStr === 'true',
      mediaJwt,
      isTauriPlatform: override?.isTauriPlatform,
    })
}
