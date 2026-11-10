/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createShowFileTool } from './show-file-tool'
import { pageDefinitionSchema } from './page-schema'

const html = '<!doctype html><html><body><button>Click</button></body></html>'
const run = (
  tool: ReturnType<typeof createShowFileTool>,
  input: { path: string; title?: string },
  signal?: AbortSignal,
) => tool.execute!(input, { toolCallId: 'show-one', messages: [], abortSignal: signal })

describe('page_show_file', () => {
  it('publishes the full verified snapshot and opens the same page', async () => {
    const readFile = mock(async () => html)
    const onOpen = mock(() => {})
    const verify = mock(async () => ({ ok: true, errors: [] }))
    const tool = createShowFileTool({ readFile, onOpen }, verify)
    const output = await run(tool, { path: 'output/game.html', title: 'Game' })
    expect(output).toMatchObject({ ok: true, page: { title: 'Game', source: { kind: 'html', html } } })
    if (output && 'ok' in output && output.ok) {
      expect(onOpen).toHaveBeenCalledWith(output.page)
    }
    expect(readFile).toHaveBeenCalledWith('output/game.html', undefined)
    expect(verify).toHaveBeenCalledWith(html)
  })

  it('returns validation errors and never opens an invalid page', async () => {
    const onOpen = mock(() => {})
    const tool = createShowFileTool({ readFile: async () => html, onOpen }, async () => ({
      ok: false,
      errors: ['Broken script'],
    }))
    expect(await run(tool, { path: 'broken.html' })).toEqual({ ok: false, errors: ['Broken script'] })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('bounds default filenames so a successfully published page can be rendered and pinned', async () => {
    const tool = createShowFileTool({ readFile: async () => html, onOpen: () => {} }, async () => ({
      ok: true,
      errors: [],
    }))
    const output = await run(tool, { path: `${'a'.repeat(250)}.html` })
    expect(output).toMatchObject({ ok: true, page: { title: 'a'.repeat(200) } })
    if (output && 'ok' in output && output.ok) {
      expect(pageDefinitionSchema.safeParse(output.page).success).toBe(true)
    }
  })

  it('rejects oversized content and non-HTML files before verification', async () => {
    const verify = mock(async () => ({ ok: true, errors: [] }))
    const tool = createShowFileTool({ readFile: async () => 'x'.repeat(2 * 1024 * 1024 + 1), onOpen: () => {} }, verify)
    expect(await run(tool, { path: 'large.html' })).toMatchObject({ ok: false })
    await expect(run(tool, { path: 'secret.txt' })).rejects.toThrow()
    expect(verify).not.toHaveBeenCalled()
  })

  it('does not publish when cancelled during file loading', async () => {
    const abort = new AbortController()
    const onOpen = mock(() => {})
    const tool = createShowFileTool(
      {
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
