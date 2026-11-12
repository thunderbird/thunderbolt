/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq, sql } from 'drizzle-orm'
import type { PageChrome, PageDefinition } from '@shared/page-protocol'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { settingsTable } from '@/db/tables'
import { updateSettings } from '@/dal/settings'
import { localSavedPagesStore } from './local-saved-pages'
import {
  createSavedPage,
  parseSavedPage,
  savedPageKey,
  savedPageKeyPrefix,
  sortSavedPages,
  type SavedPage,
} from './saved-page'

export type SavedPageRow = { key: string; value: string | null }

/** Each page is an independent synced preference, matching the existing artifact-pin storage model. */
export const getSavedPagesQuery = (db: AnyDrizzleDatabase, id?: string) =>
  db
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(id ? eq(settingsTable.key, savedPageKey(id)) : sql`${settingsTable.key} LIKE ${`${savedPageKeyPrefix}%`}`)

/** Device-local references are rejected even if imported or forged into a synced preference. */
export const savedPagesFromRows = (rows: readonly SavedPageRow[]): SavedPage[] =>
  sortSavedPages(
    rows.flatMap(({ key, value }) => {
      const page = parseSavedPage(value)
      return page && page.source.kind !== 'local-app' && key === savedPageKey(page.id) ? [page] : []
    }),
  )

/** Save an already verified HTML snapshot or URL; local app identities stay on this device. */
export const savePage = async (
  db: AnyDrizzleDatabase,
  page: PageDefinition,
  chrome: PageChrome = 'browser',
): Promise<SavedPage> => {
  const previous =
    page.source.kind === 'local-app'
      ? localSavedPagesStore.getSnapshot().find((saved) => saved.id === page.id)
      : parseSavedPage((await getSavedPagesQuery(db, page.id))[0]?.value)
  const saved = createSavedPage(page, chrome, previous)
  if (saved.source.kind === 'local-app') {
    localSavedPagesStore.save(saved)
  } else {
    await updateSettings(db, { [savedPageKey(saved.id)]: JSON.stringify(saved) })
  }
  return saved
}

/** Rename the latest saved record without changing its destination, chrome, or pin date. */
export const renameSavedPage = async (db: AnyDrizzleDatabase, id: string, title: string): Promise<SavedPage> => {
  const local = localSavedPagesStore.getSnapshot().find((saved) => saved.id === id)
  const previous = local ?? parseSavedPage((await getSavedPagesQuery(db, id))[0]?.value)
  if (!previous || previous.deletedAt !== null) {
    throw new Error('This page is no longer pinned.')
  }
  const saved = createSavedPage({ ...previous, title }, previous.chrome, previous)
  if (local) {
    localSavedPagesStore.save(saved)
  } else {
    await updateSettings(db, { [savedPageKey(id)]: JSON.stringify(saved) })
  }
  return saved
}

/** An explicit tombstone preserves unpinning across sync without deleting source chats or files. */
export const removeSavedPage = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  const local = localSavedPagesStore.getSnapshot().find((saved) => saved.id === id)
  const saved = local ?? parseSavedPage((await getSavedPagesQuery(db, id))[0]?.value)
  if (!saved) {
    return
  }
  const now = new Date().toISOString()
  const deleted = { ...saved, deletedAt: now, updatedAt: now }
  if (local) {
    localSavedPagesStore.save(deleted)
  } else {
    await updateSettings(db, { [savedPageKey(id)]: JSON.stringify(deleted) })
  }
}

/** Refresh an existing HTML pin without renaming it, changing its chrome, or reviving an unpinned page. */
export const updatePinnedPageSource = async (db: AnyDrizzleDatabase, page: PageDefinition): Promise<void> => {
  if (page.source.kind !== 'html') {
    return
  }
  await db.transaction(async (tx) => {
    const previous = parseSavedPage((await getSavedPagesQuery(tx, page.id))[0]?.value)
    if (!previous || previous.deletedAt !== null || previous.source.kind !== 'html') {
      return
    }
    await tx
      .update(settingsTable)
      .set({ value: JSON.stringify({ ...previous, source: page.source, updatedAt: new Date().toISOString() }) })
      .where(eq(settingsTable.key, savedPageKey(page.id)))
  })
}
