/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultModels, defaultModelsVersion, type SharedModel } from '@shared/defaults/models'

export type ModelsDefaults = {
  version: number
  data: readonly SharedModel[]
}

type ServerModelsDefaults = { version: number; data: SharedModel[] }

/**
 * Pick between server-supplied and bundled models defaults, preferring the
 * higher declared version. Behaves like an OTA channel: the server can hot-ship
 * new defaults without a client build; when offline / unreachable / behind, the
 * bundle wins.
 *
 * Rollback semantics are monotonic — a server that regresses its declared
 * version below what the client already has will not overwrite. To retract a
 * bad server-published set, ship a *higher* version with the reverted content.
 *
 * Sanity guards on the server payload (fall back to bundle when tripped):
 *   - version is a finite number strictly higher than the bundle's;
 *   - `data` is a non-empty array;
 *   - **at least one id in `data` overlaps with the bundle's `defaultModels`**.
 *     Without this, `cleanupRemovedDefaults` would treat every bundle-known
 *     row as retired (none appear in the server's `currentModelIds`) and
 *     soft-delete the lot, while the filtered reconcile pass would insert
 *     nothing (OTA-only-new ids have no bundled profile). Bundle acts as the
 *     floor: OTA can update or retire ids the bundle knows, but not wipe
 *     wholesale.
 */
export const pickModelsDefaults = (server: ServerModelsDefaults | undefined): ModelsDefaults => {
  if (
    server &&
    Number.isFinite(server.version) &&
    server.version > defaultModelsVersion &&
    Array.isArray(server.data) &&
    server.data.length > 0
  ) {
    const bundledIds = new Set(defaultModels.map((m) => m.id))
    if (server.data.some((m) => bundledIds.has(m.id))) {
      return { version: server.version, data: server.data }
    }
    // Payload is well-formed but has zero overlap with the bundle. Either the
    // server team shipped a wholesale replacement (needs a client build with
    // matching profiles first) or the payload is misconfigured. Either way,
    // adopting it would wipe local state — fall back to bundle and log.
    console.warn(
      `[pickModelsDefaults] Server payload rejected: ${server.data.length} model id(s) with zero overlap ` +
        `against the ${defaultModels.length} bundled defaults. Falling back to the bundled lineup.`,
    )
  }
  return { version: defaultModelsVersion, data: defaultModels }
}
