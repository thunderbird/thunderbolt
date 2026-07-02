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
 * A server payload with a bumped version but missing / non-array / empty `data`
 * is treated as malformed and rejected — otherwise `cleanupRemovedDefaults`
 * would soft-delete every unedited system model on the way past (empty
 * `currentModelIds` matches nothing) and the stored version would advance,
 * making local recovery impossible short of another OTA.
 */
export const pickModelsDefaults = (server: ServerModelsDefaults | undefined): ModelsDefaults => {
  if (server && server.version > defaultModelsVersion && Array.isArray(server.data) && server.data.length > 0) {
    return { version: server.version, data: server.data }
  }
  return { version: defaultModelsVersion, data: defaultModels }
}
