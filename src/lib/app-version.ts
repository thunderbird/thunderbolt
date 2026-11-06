/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { normalizeClientAppVersion } from '@shared/agent-core/client-identity'
import { compareSemver } from '@shared/compare-semver'
import { isAppVersionBlocked } from './app-version-unsupported'

/**
 * The `X-App-Version` header that identifies this build to OUR backend.
 *
 * Returns `{ 'X-App-Version': <version> }` when `VITE_APP_VERSION` is set at
 * build time, or `{}` when it is unset (dev builds / tests) so callers can
 * spread it unconditionally. Only attach this to requests bound for the
 * Thunderbolt backend — never to external LLM/MCP upstreams.
 */
export const appVersionHeader = (): Record<string, string> => {
  const appVersion = normalizeClientAppVersion(import.meta.env.VITE_APP_VERSION)
  return appVersion ? { 'X-App-Version': appVersion } : {}
}

/**
 * Whether `appVersion` is older than the server-enforced `minAppVersion`. Either
 * side missing = no enforcement (unset `VITE_APP_VERSION` in dev/tests, or a
 * deployment that has not enabled the gate).
 *
 * The single semver comparison behind the version gate — `App`'s render gate and
 * {@link isAppVersionUnsupported} must not drift apart on this rule.
 */
export const isVersionBelowMinimum = (appVersion?: string, minAppVersion?: string): boolean =>
  !!minAppVersion && !!appVersion && compareSemver(appVersion, minAppVersion) < 0

/**
 * Whether OUR backend considers this build too old to talk to, from either
 * signal:
 * - a 426 latched during this session ({@link isAppVersionBlocked}), or
 * - the persisted `/config` minimum already known at boot.
 *
 * Non-reactive (reads store state directly) — for imperative callers like the
 * sync layer. React components subscribe to the store and use
 * {@link isVersionBelowMinimum} instead.
 *
 * The declarative half matters: `config` is persisted while `forceUpgrade` is
 * deliberately not, so a returning stale client knows it is blocked at boot,
 * before any request has been rejected. Gating sync on the 426 alone would let
 * it open a stream and start queueing writes first.
 */
export const isAppVersionUnsupported = (): boolean =>
  isAppVersionBlocked() ||
  isVersionBelowMinimum(
    normalizeClientAppVersion(import.meta.env.VITE_APP_VERSION),
    useConfigStore.getState().config.minAppVersion,
  )
