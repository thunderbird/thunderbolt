/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createShowFileTool } from './show-file-tool'
import { pageDefinitionSchema } from './page-schema'

const publication = { sessionId: 'session-1', updated: false, presentation: 'sidebar' as const }
const html = '<!doctype html><html><body><button>Click</button></body></html>'
const run = (
  tool: ReturnType<typeof createShowFileTool>,
  input: { path: string; title?: string; pageId?: string; presentation?: 'sidebar' | 'inline' },
  signal?: AbortSignal,
) => tool.execute!(input, { toolCallId: 'show-one', messages: [], abortSignal: signal })

describe('page_show_file', () => {
  it.each([undefined, false, true])(
    'describes persistence accurately with localAppsAvailable=%s',
    (localAppsAvailable) => {
      const tool = createShowFileTool({
        scope: 'test',
        cwd: '/workspace',
        readFile: async () => html,
        onOpen: () => publication,
        localAppsAvailable,
      })
      expect(tool.description).toContain('localStorage, sessionStorage, IndexedDB, and cookies are unavailable')
      expect(tool.description).toContain('preserve HTML source, not runtime state or user-entered data')
      expect(tool.description).toContain('JSON copy/paste export/import')
      if (localAppsAvailable) {
        expect(tool.description).toContain('Use local_app')
        expect(tool.description).toContain('durable data stored by a server in the project directory')
        expect(tool.description).toContain('do not assume browser storage survives server restarts')
      } else {
        expect(tool.description).not.toContain('local_app')
      }
    },
  )

  it('publishes the full verified snapshot and opens the same page', async () => {
    const readFile = mock(async () => html)
    const onOpen = mock(() => publication)
    const verify = mock(async () => ({ ok: true, errors: [] }))
    const tool = createShowFileTool({ scope: 'test', cwd: '/workspace', readFile, onOpen }, verify)
    const output = await run(tool, { path: 'output/game.html', title: 'Game' })
    expect(output).toMatchObject({ ok: true, page: { title: 'Game', source: { kind: 'html', html } } })
    if (output && 'ok' in output && output.ok) {
      expect(onOpen).toHaveBeenCalledWith(output.page, { presentation: undefined, signal: undefined })
    }
    expect(readFile).toHaveBeenCalledWith('output/game.html', undefined)
    expect(verify).toHaveBeenCalledWith(html)
  })

  it('returns validation errors and never opens an invalid page', async () => {
    const onOpen = mock(() => publication)
    const tool = createShowFileTool(
      { scope: 'test', cwd: '/workspace', readFile: async () => html, onOpen },
      async () => ({
        ok: false,
        errors: ['Broken script'],
      }),
    )
    expect(await run(tool, { path: 'broken.html' })).toEqual({ ok: false, errors: ['Broken script'] })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('bounds default filenames so a successfully published page can be rendered and pinned', async () => {
    const tool = createShowFileTool(
      { scope: 'test', cwd: '/workspace', readFile: async () => html, onOpen: () => publication },
      async () => ({
        ok: true,
        errors: [],
      }),
    )
    const output = await run(tool, { path: `${'a'.repeat(250)}.html` })
    expect(output).toMatchObject({ ok: true, page: { title: 'a'.repeat(200) } })
    if (output && 'ok' in output && output.ok) {
      expect(pageDefinitionSchema.safeParse(output.page).success).toBe(true)
    }
  })

  it('rejects oversized content and non-HTML files before verification', async () => {
    const verify = mock(async () => ({ ok: true, errors: [] }))
    const tool = createShowFileTool(
      {
        scope: 'test',
        cwd: '/workspace',
        readFile: async () => 'x'.repeat(2 * 1024 * 1024 + 1),
        onOpen: () => publication,
      },
      verify,
    )
    expect(await run(tool, { path: 'large.html' })).toMatchObject({ ok: false })
    await expect(run(tool, { path: 'secret.txt' })).rejects.toThrow()
    expect(verify).not.toHaveBeenCalled()
  })

  it('does not publish when cancelled during file loading', async () => {
    const abort = new AbortController()
    const onOpen = mock(() => publication)
    const tool = createShowFileTool(
      {
        scope: 'test',
        cwd: '/workspace',
        readFile: async () => {
          abort.abort()
          return html
        },
        onOpen,
      },
      async () => ({ ok: true, errors: [] }),
    )
    await expect(run(tool, { path: 'page.html' }, abort.signal)).rejects.toThrow()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

it('reuses file identity across edits and supports an explicit existing page ID', async () => {
  const opened: string[] = []
  const tool = createShowFileTool(
    {
      scope: 'chat:one:sandbox',
      cwd: '/workspace',
      readFile: async () => html,
      onOpen: (page) => {
        const updated = opened.includes(page.id)
        opened.push(page.id)
        return { ...publication, updated }
      },
    },
    async () => ({ ok: true, errors: [] }),
  )
  const first = await run(tool, { path: './board.html' })
  const second = await run(tool, { path: 'board.html', title: 'Renamed board' })
  expect(first).toMatchObject({ updated: false })
  expect(second).toMatchObject({ updated: true })
  expect(opened[0]).toBe(opened[1])
  expect(await run(tool, { path: 'board.html', pageId: 'existing-random-id' })).toMatchObject({
    updated: true,
    page: { id: 'existing-random-id' },
  })
})
