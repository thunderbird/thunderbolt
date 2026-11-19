/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '../db/database-interface'
import { bindUnboundMcpCredentials } from './mcp-secrets'
import { bindModelKeyDestinations } from './models'

/**
 * Gives every stored model key and MCP credential the destination it may be
 * sent to. A credential that has none yet is bound to the URL its row has now,
 * so this runs when the database opens, before sync can move a row, and around
 * an import.
 */
export const bindCredentialDestinations = async (db: AnyDrizzleDatabase): Promise<void> => {
  await bindModelKeyDestinations(db)
  await bindUnboundMcpCredentials(db)
}
