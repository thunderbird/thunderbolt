/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { PageDefinition } from '@shared/page-protocol'
import { encryptedColumnsMap } from '@shared/e2ee-types'
import { exportUserData } from '@/dal/export'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, settingsTable } from '@/db/tables'
import { localSavedPagesStore } from './local-saved-pages'
import { createSavedPage, maxSavedPageHtmlBytes, parseSavedPage, savedPageKey } from './saved-page'
import { getSavedPagesQuery, removeSavedPage, renameSavedPage, savedPagesFromRows, savePage } from './saved-pages'

const website: PageDefinition = {
  id: 'page-one',
  title: 'Website',
  source: { kind: 'url', url: 'https://example.com/private?q=value' },
}
const html: PageDefinition = {
  id: 'page-two',
  title: 'Game',
  source: {
    kind: 'html',
    html: '<p>Playable game</p>',
    artifact: { messageId: 'message', toolCallId: 'call', chatThreadId: 'chat' },
  },
}
const local: PageDefinition = {
  id: 'page-local',
  title: 'Local app',
  source: { kind: 'local-app', appId: 'app', projectId: 'project' },
}

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await getDb().delete(settingsTable)
  await getDb().delete(chatMessagesTable)
  await getDb().delete(chatThreadsTable)
  localStorage.clear()
  localSavedPagesStore.refresh()
})

describe('saved page persistence', () => {
  it('saves independent encrypted preferences and retains chrome choice and HTML after source deletion', async () => {
    const db = getDb()
    await db.insert(chatThreadsTable).values({ id: 'chat', title: 'Source' })
    await db.insert(chatMessagesTable).values({ id: 'message', chatThreadId: 'chat', role: 'assistant', parts: [] })
    await savePage(db, website, 'browser')
    await savePage(db, html, 'app')
    await db
      .update(chatThreadsTable)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(chatThreadsTable.id, 'chat'))
    const rows = await getSavedPagesQuery(db)
    expect(rows.map((row) => row.key).sort()).toEqual(['saved-page:page-one', 'saved-page:page-two'])
    expect(rows.every((row) => !row.key.includes('example.com'))).toBe(true)
    expect(encryptedColumnsMap.settings).toContain('value')
    const pages = savedPagesFromRows(rows)
    expect(pages.find((page) => page.id === html.id)).toMatchObject({ source: html.source, chrome: 'app' })
    expect(pages.find((page) => page.id === website.id)).toMatchObject({ source: website.source, chrome: 'browser' })
  })

  it('soft-unpins and restores one page without rewriting other pins', async () => {
    const db = getDb()
    const first = await savePage(db, website)
    await savePage(db, html, 'app')
    const secondBefore = (await getSavedPagesQuery(db, html.id))[0]
    await removeSavedPage(db, website.id)
    expect(savedPagesFromRows(await getSavedPagesQuery(db)).map((page) => page.id)).toEqual([html.id])
    expect(parseSavedPage((await getSavedPagesQuery(db, website.id))[0]?.value)?.deletedAt).not.toBeNull()
    expect((await getSavedPagesQuery(db, html.id))[0]).toEqual(secondBefore)
    const restored = await savePage(db, { ...website, title: 'Renamed' }, 'app')
    expect(restored).toMatchObject({ title: 'Renamed', chrome: 'app', createdAt: first.createdAt, deletedAt: null })
    expect(await getSavedPagesQuery(db)).toHaveLength(2)
  })

  it('keeps local app shortcuts out of the database and export, including standalone apps', async () => {
    const db = getDb()
    await savePage(db, local, 'app')
    const standalone = { ...local, id: 'standalone', source: { kind: 'local-app' as const, appId: 'chat-app' } }
    await savePage(db, standalone)
    expect(await getSavedPagesQuery(db)).toEqual([])
    expect(localSavedPagesStore.getSnapshot()).toHaveLength(2)
    expect((await exportUserData(db, { id: 'owner', email: null })).tables.settings).toEqual([])
    await removeSavedPage(db, local.id)
    expect(localSavedPagesStore.getSnapshot().find((page) => page.id === local.id)?.deletedAt).not.toBeNull()
    await savePage(db, local)
    expect(localSavedPagesStore.getSnapshot().find((page) => page.id === local.id)?.deletedAt).toBeNull()
  })

  it.each([website, html, local])(
    'renames $source.kind pins without changing their content, order, or storage',
    async (page) => {
      const db = getDb()
      const before = await savePage(db, page, 'app')
      const renamed = await renameSavedPage(db, page.id, '  My page  ')
      expect(renamed).toEqual({ ...before, title: 'My page', updatedAt: renamed.updatedAt })
      if (page.source.kind === 'local-app') {
        expect(await getSavedPagesQuery(db)).toEqual([])
        expect(localSavedPagesStore.getSnapshot().find((saved) => saved.id === page.id)).toEqual(renamed)
      } else {
        expect(savedPagesFromRows(await getSavedPagesQuery(db))).toEqual([renamed])
      }
      await expect(renameSavedPage(db, page.id, '   ')).rejects.toThrow()
      await removeSavedPage(db, page.id)
      await expect(renameSavedPage(db, page.id, 'Do not restore')).rejects.toThrow('no longer pinned')
      expect(savedPagesFromRows(await getSavedPagesQuery(db))).toEqual([])
      expect(localSavedPagesStore.getSnapshot().filter((saved) => saved.deletedAt === null)).toEqual([])
    },
  )

  it('rejects local launch references smuggled into synchronized rows', () => {
    const valid = createSavedPage(website, 'browser')
    const forged = createSavedPage(local, 'app')
    expect(
      savedPagesFromRows([
        { key: savedPageKey(valid.id), value: JSON.stringify(valid) },
        { key: savedPageKey(forged.id), value: JSON.stringify(forged) },
        { key: savedPageKey('mismatched'), value: JSON.stringify(valid) },
        { key: savedPageKey('broken'), value: '{invalid' },
      ]),
    ).toEqual([valid])
  })

  it('includes HTML and website pins in the existing encrypted-backup table format', async () => {
    const db = getDb()
    await savePage(db, html, 'app')
    await savePage(db, website)
    const exported = await exportUserData(db, { id: 'owner', email: null })
    expect(savedPagesFromRows(exported.tables.settings as { key: string; value: string | null }[])).toHaveLength(2)
  })
})

describe('saved page validation', () => {
  it('rejects privileged URLs, credentials, oversized HTML and invalid keys before a write', async () => {
    const db = getDb()
    for (const url of [
      'javascript:alert(1)',
      'file:///secret',
      'data:text/html,test',
      'https://user:password@example.com',
      'https://example.com/\nprivate',
    ]) {
      await expect(savePage(db, { ...website, source: { kind: 'url', url } })).rejects.toThrow()
    }
    await expect(
      savePage(db, { ...html, source: { kind: 'html', html: 'x'.repeat(maxSavedPageHtmlBytes + 1) } }),
    ).rejects.toThrow()
    await expect(
      savePage(db, { ...html, source: { kind: 'html', html: '🌩'.repeat(Math.floor(maxSavedPageHtmlBytes / 4) + 1) } }),
    ).rejects.toThrow()
    await expect(savePage(db, { ...website, id: 'https://secret.example' })).rejects.toThrow()
    expect(await getSavedPagesQuery(db)).toEqual([])
  })

  it('does not turn future or malformed payloads into executable content', () => {
    const valid = createSavedPage(html, 'app')
    expect(parseSavedPage({ ...valid, version: 2 })).toBeNull()
    expect(parseSavedPage({ ...valid, deletedAt: 'not-a-date' })).toBeNull()
    expect(parseSavedPage({ ...valid, source: { kind: 'html', html: null } })).toBeNull()
  })
})
