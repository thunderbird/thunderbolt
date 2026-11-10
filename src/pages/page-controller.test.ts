/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createBrowserController } from '@/browser/browser-controller'
import { pageController, type PageAdapter } from './page-controller'
import { usePageStore } from './page-store'
import { createPageTools, pageSnapshotModelOutput } from './page-tools'

const observation = {
  documentId: 'doc1',
  url: 'about:srcdoc',
  title: 'Page',
  text: 'Hello',
  elements: [],
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
}
const capabilities = {
  observe: true,
  navigate: false,
  selectElement: true,
  declaredTools: false,
  screenshot: false,
  pointerInput: 'synthetic',
  keyboardInput: 'synthetic',
} as const
let disposals: (() => void)[] = []
afterEach(() => {
  disposals.forEach((dispose) => dispose())
  disposals = []
  usePageStore.setState({ sessions: [], activeId: null })
})
const setup = (adapter: Partial<PageAdapter> = {}) => {
  const id = pageController.open({
    id: crypto.randomUUID(),
    title: 'Page',
    source: { kind: 'html', html: '<p>Hello</p>' },
  })
  const act = mock(async () => undefined)
  disposals.push(pageController.register(id, { capabilities, snapshot: async () => observation, act, ...adapter }))
  const activity = createBrowserController()
  disposals.push(
    activity.registerPanel({
      listTabs: () =>
        usePageStore
          .getState()
          .sessions.map((session) => ({ id: session.id, title: 'Page', url: '', active: true, isLoading: false })),
      openTab: () => undefined,
      selectTab: () => {},
      closeTab: () => {},
    }),
  )
  return { id, act, activity }
}
describe('unified page lifecycle and capabilities', () => {
  it('keeps one document adapter across inline, sidebar, expanded presentations', async () => {
    const { id } = setup()
    const first = await pageController.adapter(id)
    for (const mode of ['inline', 'sidebar', 'expanded', 'inline'] as const) {
      usePageStore.getState().present(id, mode)
      expect(await pageController.adapter(id)).toBe(first)
      expect(await pageController.snapshot(id)).toMatchObject({ sessionId: id, documentId: 'doc1' })
    }
  })
  it('rejects a closed page result even if its native response arrives late', async () => {
    const pending = Promise.withResolvers<typeof observation>()
    const { id } = setup({ snapshot: () => pending.promise })
    const result = pageController.snapshot(id)
    await Promise.resolve()
    pageController.close(id)
    pending.resolve(observation)
    await expect(result).rejects.toThrow('closed')
  })
  it('ignores stale adapter cleanup and rejects stale snapshot replies', async () => {
    const pending = Promise.withResolvers<typeof observation>()
    const { id } = setup({ snapshot: () => pending.promise })
    const result = pageController.snapshot(id)
    await Promise.resolve()
    const replacement: PageAdapter = { capabilities, snapshot: async () => ({ ...observation, documentId: 'new' }) }
    disposals.push(pageController.register(id, replacement))
    disposals[0]()
    pending.resolve(observation)
    await expect(result).rejects.toThrow('document changed')
    expect(await pageController.snapshot(id)).toMatchObject({ documentId: 'new' })
  })
  it('rejects unsupported screenshots and mobile input before dispatch', async () => {
    const { id, act } = setup({ capabilities: { ...capabilities, pointerInput: 'none', keyboardInput: 'none' } })
    await expect(pageController.snapshot(id, true)).rejects.toThrow('Screenshots')
    await expect(pageController.act(id, { type: 'click', x: 10, y: 20 })).rejects.toThrow('does not support')
    expect(act).not.toHaveBeenCalled()
    expect(createPageTools({ allowInput: false }).page_action).toBeUndefined()
  })
  it('waits for native presentation before dispatching a snapshot or action', async () => {
    const ready = Promise.withResolvers<void>()
    const present = mock(() => ready.promise)
    const snapshot = mock(async () => observation)
    const { id, act } = setup({ present, snapshot })
    const result = pageController.act(id, { type: 'click', x: 10, y: 20 })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(present).toHaveBeenCalledTimes(1)
    expect(act).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    ready.resolve()
    await result
    expect(act).toHaveBeenCalledTimes(1)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })
  it('does not dispatch input when Stop occurs while the native surface is being presented', async () => {
    const ready = Promise.withResolvers<void>()
    const { id, act } = setup({ present: () => ready.promise })
    const abort = new AbortController()
    const result = pageController.act(id, { type: 'click', x: 10, y: 20 }, abort.signal)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    abort.abort(new Error('Stopped while presenting'))
    ready.resolve()
    await expect(result).rejects.toThrow('Stopped while presenting')
    expect(act).not.toHaveBeenCalled()
  })
  it('never targets a replacement document after presentation began', async () => {
    const ready = Promise.withResolvers<void>()
    const { id, act } = setup({ present: () => ready.promise })
    const result = pageController.act(id, { type: 'click', x: 10, y: 20 })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    disposals.push(pageController.register(id, { capabilities, snapshot: async () => observation }))
    ready.resolve()
    await expect(result).rejects.toThrow('document changed')
    expect(act).not.toHaveBeenCalled()
  })
  it('keeps the activity banner during thinking and aborts every claimed page operation on Stop', () => {
    const { id, activity } = setup()
    const finish = activity.startAgentTurn('turn')
    const agent = activity.forAgentTurn('turn')
    const signal = agent.claimPage(id)
    expect(activity.getState().busyTabId).toBe(id)
    activity.stop()
    expect(signal.aborted).toBe(true)
    expect(activity.getState().busyTabId).toBeNull()
    expect(() => agent.claimPage(id)).toThrow('stopped')
    activity.resume()
    const next = agent.claimPage(id)
    expect(next.aborted).toBe(false)
    finish()
    expect(next.aborted).toBe(true)
    expect(() => agent.claimPage(id)).toThrow('finished')
  })
  it('does not open a page after Stop or after its agent turn ends', async () => {
    const { activity } = setup()
    const finish = activity.startAgentTurn('turn')
    const tools = createPageTools({ activity: activity.forAgentTurn('turn') })
    const count = pageController.list().length
    activity.stop()
    await expect(
      tools.page_open.execute!({ url: 'https://example.com' }, { toolCallId: 'open', messages: [] }),
    ).rejects.toThrow()
    activity.resume()
    finish()
    await expect(
      tools.page_open.execute!({ url: 'https://example.com' }, { toolCallId: 'late', messages: [] }),
    ).rejects.toThrow()
    expect(pageController.list()).toHaveLength(count)
  })
  it('sends screenshot bytes as image content, keeping text observations compact', () => {
    const output = pageSnapshotModelOutput({
      output: {
        ...observation,
        pageId: 'page',
        sessionId: 'session',
        capabilities,
        screenshot: { data: 'pngbytes', mediaType: 'image/png', width: 800, height: 600 },
      },
    })
    expect(output.value[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(output.value[0])).not.toContain('pngbytes')
    expect(output.value[1]).toMatchObject({ type: 'image-data', data: 'pngbytes' })
  })
})
