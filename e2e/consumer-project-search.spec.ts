/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '../src/db/database-interface'
import { expect, test } from './test'

test('project recall maps actual PowerSync rows and excludes unrelated chats', async ({ page }) => {
  await page.route('**/__project_search__', (route) => route.fulfill({ body: '<!doctype html>' }))
  await page.goto('/__project_search__')
  const result = await page.evaluate(async () => {
    const schemaPath = '/src/db/powersync/schema.ts'
    const powerSyncPath = '/node_modules/@powersync/web/lib/index.js'
    const drizzlePath = '/node_modules/@powersync/drizzle-driver/lib/src/index.js'
    const searchPath = '/src/projects/project-search-tool.ts'
    const indexPath = '/src/search/fts-setup.ts'
    const { AppSchema, drizzleSchema } = (await import(
      /* @vite-ignore */ schemaPath
    )) as typeof import('../src/db/powersync/schema')
    const { PowerSyncDatabase, WASQLiteVFS } = (await import(
      /* @vite-ignore */ powerSyncPath
    )) as typeof import('@powersync/web')
    const { wrapPowerSyncWithDrizzle } = (await import(
      /* @vite-ignore */ drizzlePath
    )) as typeof import('@powersync/drizzle-driver')
    const { searchProjectChats } = (await import(
      /* @vite-ignore */ searchPath
    )) as typeof import('../src/projects/project-search-tool')
    const { buildCreateSql } = (await import(/* @vite-ignore */ indexPath)) as typeof import('../src/search/fts-setup')
    const database = new PowerSyncDatabase({
      schema: AppSchema,
      database: {
        dbFilename: `project-search-${crypto.randomUUID()}.db`,
        vfs: WASQLiteVFS.IDBBatchAtomicVFS,
        enableMultiTabs: false,
        useWebWorker: false,
      },
    })
    try {
      await database.init()
      await database.execute(buildCreateSql())
      for (const [id, parentId, body] of [
        ['m1', 'sibling', 'The standalone server is ready. 会議 notes.'],
        ['m2', 'unrelated', 'The standalone server belongs to another project.'],
      ]) {
        await database.execute(
          "INSERT INTO search_index(id, entity_type, parent_id, title, body) VALUES (?, 'message', ?, '', ?)",
          [id, parentId, body],
        )
      }
      const db = wrapPowerSyncWithDrizzle(database, { schema: drizzleSchema }) as unknown as AnyDrizzleDatabase
      const titles = new Map([['sibling', 'Earlier setup']])
      return {
        keyword: await searchProjectChats(db, ['sibling'], 'standalone', titles),
        substring: await searchProjectChats(db, ['sibling'], '会議', titles),
        empty: await searchProjectChats(db, ['sibling'], 'missing', titles),
      }
    } finally {
      await database.close()
    }
  })
  const expected = {
    chatThreadId: 'sibling',
    chatTitle: 'Earlier setup',
    excerpt: expect.stringContaining('standalone'),
  }
  expect(result.keyword).toEqual([expected])
  expect(result.substring).toEqual([{ ...expected, excerpt: expect.stringContaining('会議') }])
  expect(result.empty).toEqual([])
})
