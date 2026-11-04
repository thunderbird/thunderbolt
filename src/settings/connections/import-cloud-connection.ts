/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { mcpServersTable } from '@/db/tables'
import type { CloudConnectionView } from '@/cloud-agent/client'
import type { CloudLibrarySource } from '@/cloud-agent/connection-library'

/** Explicitly import a public definition, leaving this device disconnected and its secrets untouched. */
export const importCloudMcpDefinition = async (
  db: AnyDrizzleDatabase,
  connection: CloudConnectionView,
): Promise<CloudLibrarySource> => {
  if (connection.config.kind !== 'mcp') {
    throw new Error(i18n._(msg`Choose a model from Models settings to link this authorization.`))
  }
  const id = connection.config.libraryRef?.id ?? connection.record.id
  const source: CloudLibrarySource = { kind: 'mcp', id, name: connection.config.name, url: connection.config.url }
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(mcpServersTable).where(eq(mcpServersTable.id, id))
    if (existing) {
      if (existing.deletedAt || existing.url !== source.url || existing.type !== 'http') {
        throw new Error(
          i18n._(msg`This library identifier is already in use. Link another existing connection instead.`),
        )
      }
      return
    }
    await tx.insert(mcpServersTable).values({ id, name: source.name, url: source.url, type: 'http', enabled: 0 })
  })
  return source
}
