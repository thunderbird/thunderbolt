/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { invoke } from '@tauri-apps/api/core'
import { createBrowserController } from './browser-controller'
import type { BrowserTabInfo } from './types'
import { getClock } from '@/testing-library'

const page = {
  url: 'https://example.com/',
  title: 'Example',
  documentId: 'doc-1',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  text: 'Example',
  elements: [],
}
const setup = (implementation?: typeof invoke) => {
  const native = mock(
    implementation ??
      (async <T>(command: string) => (command === 'browser_agent_snapshot' ? page : { isLoading: false }) as T),
  )
  const controller = createBrowserController(native as typeof invoke)
  let tabs: BrowserTabInfo[] = [{ id: 'one', ...page, isLoading: false, active: true }]
  const present = mock(async () => undefined)
  const unregister = controller.registerPanel({
    listTabs: () => tabs,
    openTab: (url) => {
      tabs = [
        ...tabs.map((tab) => ({ ...tab, active: false })),
        { id: 'two', url: url ?? 'about:blank', title: '', isLoading: false, active: true },
      ]
      controller.registerSession('two', { label: 'native-two', present })
      return 'two'
    },
    selectTab: (id) => {
      tabs = tabs.map((tab) => ({ ...tab, active: tab.id === id }))
    },
    closeTab: (id) => {
      tabs = tabs.filter((tab) => tab.id !== id)
    },
  })
  controller.registerSession('one', { label: 'native-one', present })
  return { controller, native, present, unregister }
}

describe('browser controller', () => {
  it('keeps the last controlled tab active between tools until the agent turn ends', async () => {
    const { controller } = setup()
    const finish = controller.startAgentTurn('turn-1')
    const agent = controller.forAgentTurn('turn-1')
    const changes: (string | null)[] = []
    controller.subscribe(() => changes.push(controller.getState().busyTabId))
    expect(controller.getState().busyTabId).toBeNull()
    await agent.snapshot('one')
    await getClock().tickAsync(60_000)
    expect(controller.getState().busyTabId).toBe('one')
    await agent.snapshot('one')
    expect(changes).toEqual(['one'])
    await agent.openTab()
    expect(changes).toEqual(['one', 'two'])
    finish()
    expect(changes).toEqual(['one', 'two', null])
    await expect(agent.snapshot('one')).rejects.toThrow('turn has finished')
  })
  it('keeps simultaneous chats independent and ignores an old turn finishing twice', async () => {
    const { controller } = setup()
    const finishFirst = controller.startAgentTurn('first')
    const first = controller.forAgentTurn('first')
    const finishSecond = controller.startAgentTurn('second')
    const second = controller.forAgentTurn('second')
    await first.snapshot('one')
    await second.openTab()
    expect(controller.getState().busyTabId).toBe('two')
    finishFirst()
    expect(controller.getState().busyTabId).toBe('two')
    finishFirst()
    expect(controller.getState().busyTabId).toBe('two')
    finishSecond()
    expect(controller.getState().busyTabId).toBeNull()
  })
  it('clears retained activity on Stop, tab close, and browser close', async () => {
    const { controller, unregister } = setup()
    const finish = controller.startAgentTurn('turn')
    const agent = controller.forAgentTurn('turn')
    await agent.snapshot('one')
    controller.stop()
    expect(controller.getState()).toEqual({ busyTabId: null, paused: true })
    controller.resume()
    expect(controller.getState().busyTabId).toBeNull()
    await agent.snapshot('one')
    await agent.closeTab('one')
    expect(controller.getState().busyTabId).toBeNull()
    await agent.openTab()
    expect(controller.getState().busyTabId).toBe('two')
    unregister()
    expect(controller.getState().busyTabId).toBeNull()
    finish()
  })
  it('does not let late native completions or queued tools revive a finished turn', async () => {
    let finishNative: (value: typeof page) => void = () => undefined
    const pending = new Promise<typeof page>((resolve) => {
      finishNative = resolve
    })
    const { controller, native } = setup(async <T>() => (await pending) as T)
    const finish = controller.startAgentTurn('turn')
    const agent = controller.forAgentTurn('turn')
    const active = agent.snapshot('one').catch((error: unknown) => error)
    const queued = agent.snapshot('one').catch((error: unknown) => error)
    await getClock().tickAsync(0)
    finish()
    expect(controller.getState().busyTabId).toBeNull()
    finishNative(page)
    expect(await active).toHaveProperty('message', 'The agent turn has finished.')
    expect(await queued).toHaveProperty('message', 'The agent turn has finished.')
    expect(native).toHaveBeenCalledTimes(1)
    expect(controller.getState().busyTabId).toBeNull()
  })
  it('cancels a pending tab close when its turn ends without blocking later tools', async () => {
    const { controller } = setup()
    const tabs = controller.listTabs()
    controller.registerPanel({
      listTabs: () => tabs,
      openTab: () => undefined,
      selectTab: () => undefined,
      closeTab: () => undefined,
    })
    const finish = controller.startAgentTurn('closing')
    const closing = controller
      .forAgentTurn('closing')
      .closeTab('one')
      .catch((error: unknown) => error)
    await getClock().tickAsync(0)
    finish()
    await getClock().tickAsync(25)
    expect(await closing).toHaveProperty('message', 'The agent turn has finished.')
    expect((await controller.snapshot('one')).tabId).toBe('one')
  })
  it('allows a completed last-tab close to tear down its own panel', async () => {
    const { controller } = setup()
    const tabs = controller.listTabs()
    const unregister = controller.registerPanel({
      listTabs: () => tabs,
      openTab: () => undefined,
      selectTab: () => undefined,
      closeTab: () => unregister(),
    })
    const finish = controller.startAgentTurn('closing')
    await controller.forAgentTurn('closing').closeTab('one')
    expect(controller.listTabs()).toEqual([])
    expect(controller.getState().busyTabId).toBeNull()
    finish()
  })
  it('selects and presents the live native session before observing, keeping native labels private', async () => {
    const { controller, native, present } = setup()
    const result = await controller.snapshot('one', { screenshot: true })
    expect(present).toHaveBeenCalledTimes(1)
    expect(native).toHaveBeenCalledWith('browser_agent_snapshot', { label: 'native-one', screenshot: true })
    expect(result.tabId).toBe('one')
    expect(controller.getState()).toEqual({ busyTabId: null, paused: false })
  })
  it('opens a blank tab, selects it, and returns a live list after closing it', async () => {
    const { controller } = setup()
    expect((await controller.openTab('about:blank')).url).toBe('about:blank')
    expect((await controller.selectTab('one')).active).toBe(true)
    await controller.closeTab('two')
    expect(controller.listTabs().map((tab) => tab.id)).toEqual(['one'])
  })
  it('opens a browser panel on demand through its registered UI owner', async () => {
    const controller = createBrowserController()
    const info = { id: 'new', url: 'https://example.com/', title: '', isLoading: false, active: true }
    const open = mock(() => {
      controller.registerPanel({
        listTabs: () => [info],
        openTab: () => 'new',
        selectTab: () => undefined,
        closeTab: () => undefined,
      })
      controller.registerSession('new', { label: 'native-new', present: async () => undefined })
    })
    const show = mock(() => undefined)
    controller.registerOpener(open, show)
    expect(await controller.openTab(info.url)).toEqual(info)
    expect(open).toHaveBeenCalledWith(info.url)
    expect(show).toHaveBeenCalledTimes(1)
  })
  it('rejects missing tabs and unsafe navigation before invoking native code', async () => {
    const { controller, native } = setup()
    await expect(controller.snapshot('missing')).rejects.toThrow('no longer exists')
    await expect(controller.navigate('one', { url: 'javascript:alert(1)' })).rejects.toThrow('HTTP(S)')
    await expect(controller.openTab('file:///private/test')).rejects.toThrow('HTTP(S)')
    expect(native).not.toHaveBeenCalled()
  })
  it('does not run already-cancelled tab mutations', async () => {
    const { controller } = setup()
    const abort = AbortSignal.abort(new Error('Cancelled'))
    await expect(controller.openTab(undefined, abort)).rejects.toThrow('Cancelled')
    await expect(controller.closeTab('one', abort)).rejects.toThrow('Cancelled')
    expect(controller.listTabs()).toHaveLength(1)
  })
  it('stops in-flight and queued work until the user resumes', async () => {
    let finish: (value: typeof page) => void = () => undefined
    const pending = new Promise<typeof page>((resolve) => {
      finish = resolve
    })
    const { controller, native } = setup(async <T>() => (await pending) as T)
    const first = controller.snapshot('one').catch((error: unknown) => error)
    const queued = controller.snapshot('one').catch((error: unknown) => error)
    await getClock().tickAsync(0)
    controller.stop()
    await expect(controller.snapshot('one')).rejects.toThrow('stopped')
    finish(page)
    expect(await first).toHaveProperty('message', 'Browser control stopped by the user.')
    expect(await queued).toHaveProperty('message', 'Browser control stopped by the user.')
    expect(native).toHaveBeenCalledTimes(1)
    controller.resume()
    expect((await controller.snapshot('one')).documentId).toBe('doc-1')
  })
  it('rejects late observations from a closed browser generation', async () => {
    let finish: (value: typeof page) => void = () => undefined
    const pending = new Promise<typeof page>((resolve) => {
      finish = resolve
    })
    const { controller, unregister } = setup(async <T>() => (await pending) as T)
    const observation = controller.snapshot('one')
    await getClock().tickAsync(0)
    unregister()
    finish(page)
    await expect(observation).rejects.toThrow('closed')
    expect(controller.listTabs()).toEqual([])
  })
  it('does not revive queued work when resumed before the interrupted native call finishes', async () => {
    let finish: (value: typeof page) => void = () => undefined
    const pending = new Promise<typeof page>((resolve) => {
      finish = resolve
    })
    const { controller, native } = setup(async <T>() => (await pending) as T)
    const first = controller.snapshot('one').catch((error: unknown) => error)
    const queued = controller.snapshot('one').catch((error: unknown) => error)
    await getClock().tickAsync(0)
    controller.stop()
    controller.resume()
    const resumed = controller.snapshot('one')
    finish(page)
    expect(await first).toHaveProperty('message', 'Browser control stopped by the user.')
    expect(await queued).toHaveProperty('message', 'Browser control stopped by the user.')
    expect((await resumed).documentId).toBe('doc-1')
    expect(native).toHaveBeenCalledTimes(2)
  })
  it('does not let stale session cleanup remove a replacement', async () => {
    const { controller, native } = setup()
    const cleanup = controller.registerSession('one', { label: 'old', present: async () => undefined })
    controller.registerSession('one', { label: 'replacement', present: async () => undefined })
    cleanup()
    await controller.snapshot('one')
    expect(native).toHaveBeenCalledWith('browser_agent_snapshot', { label: 'replacement', screenshot: false })
  })
  it('settles navigation and returns a fresh observation', async () => {
    const { controller, native } = setup()
    const navigation = controller.navigate('one', { url: 'https://mozilla.org/' })
    await getClock().tickAsync(500)
    expect((await navigation).tabId).toBe('one')
    expect(native).toHaveBeenCalledWith('browser_navigate', { label: 'native-one', url: 'https://mozilla.org/' })
    expect(native.mock.calls.at(-1)?.[0]).toBe('browser_agent_snapshot')
  })
})
