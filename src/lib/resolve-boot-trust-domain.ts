/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppConfig } from '@/api/config-store'
import {
  getActiveTrustDomain,
  useTrustDomainRegistry,
  type ActiveTrustDomain,
  type ServerEntry,
} from '@/stores/trust-domain-registry'

/**
 * Boot-time decision tree for which trust domain the app is going to operate in.
 *
 * Cases (in order):
 *   1. Registry already has an `activeTrustDomain` → use it (returning device).
 *   2. Registry empty + env allows standalone → standalone.
 *   3. Registry empty + env has a default server URL → fetch `/v1/config` from it,
 *      pin the returned `serverId`, and pick the server trust domain.
 *   4. Otherwise → no trust domain (mode picker — built in PR 5; v1 prod never hits).
 */

export type BootEnv = {
  standaloneModeEnabled: boolean
  /** Empty string = unset. */
  defaultServerUrl: string
}

export type BootResolution =
  | { kind: 'resolved'; trustDomain: ActiveTrustDomain; serverEntry?: ServerEntry }
  | { kind: 'no-trust-domain' }
  | { kind: 'fetch-failed'; cloudUrl: string }

type FetchConfigFn = (cloudUrl: string) => Promise<AppConfig | null>

export const resolveBootTrustDomain = async ({
  env,
  fetchConfig,
}: {
  env: BootEnv
  fetchConfig: FetchConfigFn
}): Promise<BootResolution> => {
  const activeTrustDomain = getActiveTrustDomain()
  const { servers } = useTrustDomainRegistry.getState()

  if (activeTrustDomain?.kind === 'standalone') {
    return { kind: 'resolved', trustDomain: activeTrustDomain }
  }
  if (activeTrustDomain?.kind === 'server' && servers[activeTrustDomain.serverId]) {
    return { kind: 'resolved', trustDomain: activeTrustDomain, serverEntry: servers[activeTrustDomain.serverId] }
  }

  // First boot (or a registry that referenced a missing server entry).
  if (env.standaloneModeEnabled) {
    return { kind: 'resolved', trustDomain: { kind: 'standalone' } }
  }
  if (env.defaultServerUrl) {
    const config = await fetchConfig(env.defaultServerUrl)
    if (!config?.serverId) {
      return { kind: 'fetch-failed', cloudUrl: env.defaultServerUrl }
    }
    return {
      kind: 'resolved',
      trustDomain: { kind: 'server', serverId: config.serverId },
      serverEntry: { serverId: config.serverId, cloudUrl: env.defaultServerUrl },
    }
  }
  return { kind: 'no-trust-domain' }
}
