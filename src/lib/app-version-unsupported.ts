/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Dispatched when OUR backend hard-rejects the client's app version (HTTP 426
 * or an `APP_VERSION_UNSUPPORTED` error code). Mirrors the credentials-invalid
 * event pattern in `src/db/powersync/connector.ts`: a standalone detector that
 * fires a window `CustomEvent` so a React listener can flip the app into the
 * upgrade blocker. Kept dependency-free (no connector import) so the HTTP
 * client can call it without the http → connector import cycle.
 */
export const appVersionUnsupported = 'app_version_unsupported'

type AppVersionUnsupportedBody = { code?: string; minAppVersion?: string }

/**
 * Latched for the rest of the session on the first 426. Set synchronously by
 * {@link handleAppVersionUnsupported} — before the event dispatch — so the sync
 * layer can refuse to (re)connect even if it observes the block through a
 * different path than the listener (an in-flight connect, or a 426 that lands
 * before the database module has loaded).
 */
let versionBlocked = false

/**
 * Whether OUR backend has rejected this build's version during this session.
 * Sync treats this as a hard stop: a version-blocked client must not hold a sync
 * stream, because its writes would sit in the CRUD queue and flush later under
 * indeterminate encryption-key state.
 */
export const isAppVersionBlocked = (): boolean => versionBlocked

/** @internal Reset the session latch between tests. */
export const resetAppVersionBlockedForTesting = () => {
  versionBlocked = false
}

/**
 * When `status` is 426 (or the parsed body carries
 * `code === 'APP_VERSION_UNSUPPORTED'`), latch the version block, dispatch
 * {@link appVersionUnsupported} with the server-advertised minimum version and
 * return `true`. Returns `false` otherwise so callers can fall through to their
 * normal error handling.
 */
export const handleAppVersionUnsupported = (status: number, body?: AppVersionUnsupportedBody): boolean => {
  if (status !== 426 && body?.code !== 'APP_VERSION_UNSUPPORTED') {
    return false
  }
  versionBlocked = true
  window.dispatchEvent(new CustomEvent(appVersionUnsupported, { detail: { minAppVersion: body?.minAppVersion } }))
  return true
}
