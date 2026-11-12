/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { settingsTable } from '@/db/tables'
import { nowIso } from '@/lib/utils'
import { canUseSavedMemory } from '@/memory/access'
import { validateMemoryContent } from '@/memory/limits'
import { getMemoryRevision } from '@/memory/revision'
import { getSettings } from './settings'

export type MemoryDocument = { content: string }

type MemoryAccessOptions = {
  signal?: AbortSignal
  requireEnabled?: boolean
  currentThreadId?: string
}

type MemorySnapshot =
  | { expectedContent: string; expectedRevision?: never }
  | { expectedRevision: string; expectedContent?: never }

export class MemoryDisabledError extends Error {
  constructor() {
    super('Memory is disabled or unavailable in this chat.')
    this.name = 'MemoryDisabledError'
  }
}

export class MemoryConflictError extends Error {
  constructor() {
    super('Memory changed while you were editing. Read the latest document before trying again.')
    this.name = 'MemoryConflictError'
  }
}

/** Recheck consent and chat privacy at the transaction boundary, not just tool registration. */
const assertMemoryAccess = async (db: AnyDrizzleDatabase, options: MemoryAccessOptions): Promise<void> => {
  options.signal?.throwIfAborted()
  if (options.requireEnabled || options.currentThreadId !== undefined) {
    if (!(await canUseSavedMemory(db, options.currentThreadId))) {
      throw new MemoryDisabledError()
    }
  }
  options.signal?.throwIfAborted()
}

/** Read the single synced document; agent reads require a live, public chat and current consent. */
export const getMemoryDocument = async (
  db: AnyDrizzleDatabase,
  options: MemoryAccessOptions = {},
): Promise<MemoryDocument> => {
  await assertMemoryAccess(db, options)
  const { memoryContent } = await getSettings(db, { memory_content: '' })
  await assertMemoryAccess(db, options)
  return { content: memoryContent }
}

/** Atomically replace an exact snapshot, preserving line breaks and clearing by writing an empty value. */
export const saveMemoryDocument = async (
  db: AnyDrizzleDatabase,
  content: string,
  options: MemoryAccessOptions & MemorySnapshot,
): Promise<MemoryDocument> => {
  validateMemoryContent(content)
  return db.transaction(async (tx) => {
    await assertMemoryAccess(tx, options)
    const current = await tx.select().from(settingsTable).where(eq(settingsTable.key, 'memory_content')).get()
    const currentContent = current?.value ?? ''
    const matches =
      options.expectedRevision !== undefined
        ? (await getMemoryRevision(currentContent)) === options.expectedRevision
        : currentContent === options.expectedContent
    if (!matches) {
      throw new MemoryConflictError()
    }
    options.signal?.throwIfAborted()
    const values = { value: content, updatedAt: nowIso() }
    // PowerSync tables are SQLite views and do not support ON CONFLICT.
    if (current) {
      await tx.update(settingsTable).set(values).where(eq(settingsTable.key, 'memory_content'))
    } else {
      await tx.insert(settingsTable).values({ key: 'memory_content', ...values })
    }
    await assertMemoryAccess(tx, options)
    return { content }
  })
}
