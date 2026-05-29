/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth } from '@/contexts'
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled } from '@/lib/proxy-fetch'
import { useLocalStorage } from './use-local-storage'

type UseAgentsSettingsHiddenDeps = {
  /** Override Tauri detection (tests inject an explicit boolean to avoid
   *  mocking `@/lib/platform`, which would leak across files — see
   *  `docs/development/testing.md`). */
  isStandalone?: () => boolean
}

/**
 * Anonymous users can't authenticate to the universal proxy (the ACP managed
 * agents path requires a real user). When that path is the only one available
 * — i.e. anon + proxy on — the Agents settings page is dead UI, so hide it.
 *
 * Tauri Standalone (proxy off) still works for anon because ACP connects
 * direct upstream, so the entry stays visible there.
 *
 *   - Web anon         → proxy is always on (CORS forces it)         → hidden
 *   - Tauri Connected  → proxy on, ACP rejects anon                  → hidden
 *   - Tauri Standalone → proxy off, direct ACP works                 → visible
 */
export const useAgentsSettingsHidden = (deps?: UseAgentsSettingsHiddenDeps): boolean => {
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const isAnonymous = session?.user?.isAnonymous === true
  const [proxyEnabledStr] = useLocalStorage('proxy_enabled', 'false')
  const standalone = (deps?.isStandalone ?? isTauri)()
  const effectiveProxyEnabled = computeEffectiveProxyEnabled(
    () => standalone,
    () => proxyEnabledStr,
  )
  return isAnonymous && effectiveProxyEnabled
}
