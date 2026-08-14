/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The `X-App-Version` header that identifies this build to OUR backend.
 *
 * Returns `{ 'X-App-Version': <version> }` when `VITE_APP_VERSION` is set at
 * build time, or `{}` when it is unset (dev builds / tests) so callers can
 * spread it unconditionally. Only attach this to requests bound for the
 * Thunderbolt backend — never to external LLM/MCP upstreams.
 */
export const appVersionHeader = (): Record<string, string> =>
  import.meta.env.VITE_APP_VERSION ? { 'X-App-Version': import.meta.env.VITE_APP_VERSION } : {}
