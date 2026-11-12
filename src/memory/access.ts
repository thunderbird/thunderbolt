/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, isNull } from 'drizzle-orm'
import { getSettings } from '@/dal/settings'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatThreadsTable, mcpServersTable } from '@/db/tables'
import { getMemoryMcpProvider } from './providers'
import { memoryProviderForServer } from './selection'

export type MemoryProviderTarget = { id: string; url: string }

/** Saved memory belongs only to known public chats with current user consent. */
export const canUseSavedMemory = async (
  db: AnyDrizzleDatabase,
  currentThreadId?: string,
  provider?: MemoryProviderTarget,
): Promise<boolean> => {
  if (!currentThreadId) {
    return false
  }
  const { memoryEnabled, memoryProvider } = await getSettings(db, {
    memory_enabled: false,
    memory_provider: 'builtin',
  })
  if (!memoryEnabled || memoryProvider !== (provider ? memoryProviderForServer(provider.id) : 'builtin')) {
    return false
  }
  if (provider) {
    const server = await db
      .select({ url: mcpServersTable.url })
      .from(mcpServersTable)
      .where(
        and(eq(mcpServersTable.id, provider.id), eq(mcpServersTable.enabled, 1), isNull(mcpServersTable.deletedAt)),
      )
      .get()
    // A replaced connection cannot lend its consent to a stale transport closure.
    if (!server || server.url !== provider.url || !getMemoryMcpProvider(server.url)) {
      return false
    }
  }
  const thread = await db
    .select({ isEncrypted: chatThreadsTable.isEncrypted })
    .from(chatThreadsTable)
    .where(and(eq(chatThreadsTable.id, currentThreadId), isNull(chatThreadsTable.deletedAt)))
    .get()
  return thread?.isEncrypted === 0
}
