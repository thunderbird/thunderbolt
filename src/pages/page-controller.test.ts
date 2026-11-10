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
    const entered = Promise.withResolvers<void>()
    const { id } = setup({
      snapshot: () => {
        entered.resolve()
        return pending.promise
      },
    })
    const result = pageController.snapshot(id)
    await entered.promise
    pageController.close(id)
    pending.resolve(observation)
    await expect(result).rejects.toThrow('closed')
  })
  it('ignores stale adapter cleanup and rejects stale snapshot replies', async () => {
    const pending = Promise.withResolvers<typeof observation>()
    const entered = Promise.withResolvers<void>()
    const { id } = setup({
      snapshot: () => {
        entered.resolve()
        return pending.promise
      },
    })
    const result = pageController.snapshot(id)
    await entered.promise
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
    const entered = Promise.withResolvers<void>()
    const present = mock(() => {
      entered.resolve()
      return ready.promise
    })
    const snapshot = mock(async () => observation)
    const { id, act } = setup({ present, snapshot })
    const result = pageController.act(id, { type: 'click', x: 10, y: 20 })
    await entered.promise
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
    const entered = Promise.withResolvers<void>()
    const { id, act } = setup({
      present: () => {
        entered.resolve()
        return ready.promise
      },
    })
    const abort = new AbortController()
    const result = pageController.act(id, { type: 'click', x: 10, y: 20 }, { signal: abort.signal })
    await entered.promise
    abort.abort(new Error('Stopped while presenting'))
    ready.resolve()
    await expect(result).rejects.toThrow('Stopped while presenting')
    expect(act).not.toHaveBeenCalled()
  })
  it('never targets a replacement document after presentation began', async () => {
    const ready = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const { id, act } = setup({
      present: () => {
        entered.resolve()
        return ready.promise
      },
    })
    const result = pageController.act(id, { type: 'click', x: 10, y: 20 })
    await entered.promise
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
  it('queues navigation and observations behind input without moving the active native viewport', async () => {
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const first = setup({
      act: async () => {
        entered.resolve()
        await complete.promise
      },
    })
    const navigated = mock(async () => {})
    const second = setup({ capabilities: { ...capabilities, navigate: true }, navigate: navigated })
    const click = pageController.act(first.id, { type: 'click', x: 10, y: 20 })
    await entered.promise
    const navigation = pageController.navigate(second.id, { type: 'navigate', url: 'https://example.com' })
    const snapshot = pageController.snapshot(second.id)
    await Promise.resolve()
    expect(usePageStore.getState().activeId).toBe(first.id)
    expect(navigated).not.toHaveBeenCalled()
    complete.resolve()
    await Promise.all([click, navigation, snapshot])
    expect(navigated).toHaveBeenCalledTimes(1)
    expect(usePageStore.getState().activeId).toBe(second.id)
  })
  it('does not navigate after Stop while waiting for the previous operation', async () => {
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const first = setup({
      act: async () => {
        entered.resolve()
        await complete.promise
      },
    })
    const navigate = mock(async () => {})
    const second = setup({ capabilities: { ...capabilities, navigate: true }, navigate })
    const click = pageController.act(first.id, { type: 'click', x: 10, y: 20 })
    await entered.promise
    const stopped = new AbortController()
    const navigation = pageController.navigate(second.id, { type: 'reload' }, { signal: stopped.signal })
    stopped.abort(new Error('Stopped'))
    complete.resolve()
    await click
    await expect(navigation).rejects.toThrow('Stopped')
    expect(navigate).not.toHaveBeenCalled()
    expect((await pageController.snapshot(second.id)).documentId).toBe('doc1')
  })
  it('queues agent tab lifecycle changes and cancels them without changing user tabs', async () => {
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const first = setup({
      act: async () => {
        entered.resolve()
        await complete.promise
      },
    })
    const second = setup()
    const click = pageController.act(first.id, { type: 'click', x: 10, y: 20 })
    await entered.promise
    const abort = new AbortController()
    const opening = pageController.openForAgent(
      { id: 'cancelled-open', title: '', source: { kind: 'url', url: 'about:blank' } },
      { signal: abort.signal },
    )
    const selection = pageController.selectForAgent(second.id, { signal: abort.signal })
    const closing = pageController.closeForAgent(first.id, { signal: abort.signal })
    const results = Promise.allSettled([opening, selection, closing])
    await Promise.resolve()
    expect(usePageStore.getState().activeId).toBe(first.id)
    expect(usePageStore.getState().sessions).toHaveLength(2)
    abort.abort(new Error('Stopped'))
    complete.resolve()
    await click
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(usePageStore.getState().sessions).toHaveLength(2)
    await pageController.selectForAgent(second.id)
    expect(usePageStore.getState().activeId).toBe(second.id)
    await pageController.closeForAgent(first.id)
    expect(usePageStore.getState().sessions.map((session) => session.id)).toEqual([second.id])
  })
  it('awaits navigation before returning the destination observation and forwards cancellation', async () => {
    const arrived = Promise.withResolvers<void>()
    const navigating = Promise.withResolvers<void>()
    const snapshot = mock(async () => ({
      ...observation,
      url: 'https://destination.example',
      documentId: 'destination',
    }))
    const navigate = mock(async () => {
      navigating.resolve()
      await arrived.promise
    })
    const { id } = setup({ capabilities: { ...capabilities, navigate: true }, navigate, snapshot })
    const controller = new AbortController()
    const result = pageController.navigate(
      id,
      { type: 'navigate', url: 'https://destination.example' },
      { signal: controller.signal },
    )
    await navigating.promise
    expect(snapshot).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ type: 'navigate', url: 'https://destination.example' }, controller.signal)
    arrived.resolve()
    expect(await result).toMatchObject({ url: 'https://destination.example', documentId: 'destination' })
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

  it('keeps Stop on the running tab when a second chat queues input, then transfers activity when it starts', async () => {
    const firstEntered = Promise.withResolvers<void>()
    const firstComplete = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const secondComplete = Promise.withResolvers<void>()
    const first = setup({
      act: async () => {
        firstEntered.resolve()
        await firstComplete.promise
      },
    })
    const second = setup({
      act: async () => {
        secondEntered.resolve()
        await secondComplete.promise
      },
    })
    disposals.push(first.activity.startAgentTurn('chat-a'), first.activity.startAgentTurn('chat-b'))
    const firstTools = createPageTools({ activity: first.activity.forAgentTurn('chat-a') })
    const secondTools = createPageTools({ activity: first.activity.forAgentTurn('chat-b') })
    const firstAction = firstTools.page_action.execute!(
      { sessionId: first.id, type: 'click', x: 10, y: 20 },
      { toolCallId: 'a', messages: [] },
    )
    await firstEntered.promise
    const secondAction = secondTools.page_action.execute!(
      { sessionId: second.id, type: 'click', x: 10, y: 20 },
      { toolCallId: 'b', messages: [] },
    )
    await Promise.resolve()
    expect(first.activity.getState().busyTabId).toBe(first.id)
    expect(usePageStore.getState().activeId).toBe(first.id)
    firstComplete.resolve()
    await secondEntered.promise
    expect(first.activity.getState().busyTabId).toBe(second.id)
    expect(usePageStore.getState().activeId).toBe(second.id)
    secondComplete.resolve()
    await Promise.all([firstAction, secondAction])
  })

  it('claims an opened page inside its queue entry before the next chat starts an action', async () => {
    const entered = Promise.withResolvers<void>()
    const complete = Promise.withResolvers<void>()
    const existing = setup({
      act: async () => {
        entered.resolve()
        await complete.promise
      },
    })
    disposals.push(existing.activity.startAgentTurn('opener'), existing.activity.startAgentTurn('actor'))
    const opener = createPageTools({ activity: existing.activity.forAgentTurn('opener') })
    const actor = createPageTools({ activity: existing.activity.forAgentTurn('actor') })
    const claims: (string | null)[] = []
    disposals.push(existing.activity.subscribe(() => claims.push(existing.activity.getState().busyTabId)))
    const opening = opener.page_open.execute!({ url: 'https://example.com' }, { toolCallId: 'open', messages: [] })
    const acting = actor.page_action.execute!(
      { sessionId: existing.id, type: 'click', x: 10, y: 20 },
      { toolCallId: 'act', messages: [] },
    )
    await entered.promise
    await opening
    const opened = usePageStore.getState().sessions.find((session) => session.id !== existing.id)!
    expect(claims).toEqual([opened.id, existing.id])
    expect(existing.activity.getState().busyTabId).toBe(existing.id)
    complete.resolve()
    await acting
  })

  it.each(['page_open', 'page_select', 'page_close', 'page_snapshot', 'page_navigate'] as const)(
    'does not move the running chat’s Stop banner for a queued %s, and cancels it on Stop',
    async (toolName) => {
      const entered = Promise.withResolvers<void>()
      const complete = Promise.withResolvers<void>()
      const first = setup({
        act: async () => {
          entered.resolve()
          await complete.promise
        },
      })
      const navigate = mock(async () => {})
      const snapshot = mock(async () => observation)
      const second = setup({ capabilities: { ...capabilities, navigate: true }, navigate, snapshot })
      disposals.push(first.activity.startAgentTurn('chat-a'), first.activity.startAgentTurn('chat-b'))
      const firstTools = createPageTools({ activity: first.activity.forAgentTurn('chat-a') })
      const secondTools = createPageTools({ activity: first.activity.forAgentTurn('chat-b') })
      const firstAction = firstTools.page_action.execute!(
        { sessionId: first.id, type: 'click', x: 10, y: 20 },
        { toolCallId: 'a', messages: [] },
      )
      await entered.promise
      const queued = secondTools[toolName].execute!(
        { sessionId: second.id, action: 'reload', url: 'https://example.com' },
        { toolCallId: 'b', messages: [] },
      )
      const outcomes = Promise.allSettled([firstAction, queued])
      expect(first.activity.getState().busyTabId).toBe(first.id)
      first.activity.stop()
      complete.resolve()
      expect((await outcomes).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
      expect(first.activity.getState()).toEqual({ busyTabId: null, paused: true })
      expect(usePageStore.getState().sessions).toHaveLength(2)
      expect(usePageStore.getState().activeId).toBe(first.id)
      expect(navigate).not.toHaveBeenCalled()
      expect(snapshot).not.toHaveBeenCalled()
    },
  )
})
