/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { PageDefinition } from '@shared/page-protocol'
import { publishGeneratedPage } from './publish-generated-page'
import { getSavedPagesQuery, savePage, savedPagesFromRows } from './saved-pages'
import { usePageStore } from './page-store'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => usePageStore.setState({ sessions: [], activeId: null }))

const htmlPage = (id: string, html: string): PageDefinition => ({
  id,
  title: 'Generated app',
  source: { kind: 'html', html },
})

describe('explicit HTML publication', () => {
  it('opens a new app in the sidebar and updates the same tab and pin on revision', async () => {
    const firstPage = htmlPage(crypto.randomUUID(), '<p>First version</p>')
    const first = await publishGeneratedPage(firstPage)
    expect(first).toMatchObject({ updated: false, presentation: 'sidebar' })
    await savePage(getDb(), { ...firstPage, title: 'My chosen name' }, 'app')
    usePageStore.getState().present(first.sessionId, 'inline')
    const latestPage = htmlPage(firstPage.id, '<p>Latest version</p>')
    const second = await publishGeneratedPage(latestPage, { presentation: 'sidebar' })
    expect(second).toEqual({ sessionId: first.sessionId, updated: true, presentation: 'inline' })
    expect(usePageStore.getState().sessions).toHaveLength(1)
    expect(usePageStore.getState().sessions[0].page).toEqual(latestPage)
    expect(savedPagesFromRows(await getSavedPagesQuery(getDb(), firstPage.id))[0]).toMatchObject({
      title: 'My chosen name',
      chrome: 'app',
      source: latestPage.source,
    })
    usePageStore.getState().ensure(firstPage)
    expect(usePageStore.getState().sessions[0].page).toEqual(latestPage)
  })

  it('does not open inline graphics in the browser panel', async () => {
    const result = await publishGeneratedPage(htmlPage(crypto.randomUUID(), '<svg></svg>'), { presentation: 'inline' })
    expect(result.presentation).toBe('inline')
    expect(usePageStore.getState().activeId).toBeNull()
  })

  it('does not publish after cancellation or replace a non-HTML destination', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(publishGeneratedPage(htmlPage('aborted', '<p>No</p>'), { signal: abort.signal })).rejects.toThrow()
    expect(usePageStore.getState().sessions).toEqual([])
    usePageStore
      .getState()
      .ensure({ id: 'website', title: 'Website', source: { kind: 'url', url: 'https://example.com' } })
    await expect(publishGeneratedPage(htmlPage('website', '<p>No</p>'))).rejects.toThrow('only replace an HTML page')
    expect(usePageStore.getState().sessions[0].page.source.kind).toBe('url')
  })
})
