/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import type { Tool, ToolCallOptions } from 'ai'
import { browserSnapshotModelOutput, createBrowserTools, type BrowserToolController } from './browser-tools'
import type { BrowserSnapshot, BrowserTabInfo } from './types'

const tab: BrowserTabInfo = {
  id: 'tab-1',
  url: 'https://example.com/',
  title: 'Example',
  isLoading: false,
  active: true,
}

const page: BrowserSnapshot = {
  tabId: tab.id,
  url: tab.url,
  title: tab.title,
  documentId: 'document-1',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  text: 'Example page',
  elements: [
    { ref: 'document-1:1', tag: 'button', role: 'button', name: 'Save', rect: { x: 5, y: 10, width: 40, height: 20 } },
  ],
}

const callOptions: ToolCallOptions = { toolCallId: 'test-call', messages: [] }

/** Invoke the public execution boundary, including validation normally performed by the model SDK. */
const run = async (entry: Tool, input: unknown, abortSignal?: AbortSignal) =>
  await entry.execute?.(input as never, { ...callOptions, abortSignal })

/** Give each test independent browser state and spies without loading native APIs. */
const setup = () => {
  const controller = {
    listTabs: mock(() => [tab]),
    openTab: mock(async () => tab),
    selectTab: mock(async () => tab),
    closeTab: mock(async () => {}),
    snapshot: mock(async () => page),
    navigate: mock(async () => page),
    act: mock(async () => page),
  } satisfies BrowserToolController
  return { controller, tools: createBrowserTools(controller) }
}

describe('desktop browser tools', () => {
  it('lists current tabs and opens a browser through the controller', async () => {
    const { controller, tools } = setup()
    expect(await run(tools.browser_tabs, { action: 'list' })).toEqual({ tabs: [tab] })
    expect(await run(tools.browser_tabs, { action: 'open', url: tab.url })).toEqual({ tab })
    expect(controller.openTab).toHaveBeenCalledWith(tab.url, undefined)
    await run(tools.browser_tabs, { action: 'open' })
    expect(controller.openTab).toHaveBeenLastCalledWith(undefined, undefined)
  })

  it('selects exact tab ids and returns the remaining tabs after closing', async () => {
    const { controller, tools } = setup()
    await run(tools.browser_tabs, { action: 'select', tabId: tab.id })
    expect(controller.selectTab).toHaveBeenCalledWith(tab.id, undefined)
    expect(await run(tools.browser_tabs, { action: 'close', tabId: tab.id })).toEqual({ tabs: [tab] })
    expect(controller.closeTab).toHaveBeenCalledWith(tab.id, undefined)
    await expect(run(tools.browser_tabs, { action: 'close' })).rejects.toThrow('Provide tabId')
  })

  it('reads snapshots again on identical calls and forwards image requests and cancellation', async () => {
    const { controller, tools } = setup()
    const signal = new AbortController().signal
    await run(tools.browser_snapshot, { tabId: tab.id, screenshot: true }, signal)
    await run(tools.browser_snapshot, { tabId: tab.id, screenshot: true }, signal)
    expect(controller.snapshot).toHaveBeenCalledTimes(2)
    expect(controller.snapshot).toHaveBeenCalledWith(tab.id, { screenshot: true, signal })
  })

  it('routes navigation and history operations with the abort signal', async () => {
    const { controller, tools } = setup()
    const signal = new AbortController().signal
    await run(tools.browser_navigate, { tabId: tab.id, action: 'navigate', url: tab.url }, signal)
    expect(controller.navigate).toHaveBeenCalledWith(tab.id, { url: tab.url }, signal)
    await run(tools.browser_navigate, { tabId: tab.id, action: 'back' }, signal)
    expect(controller.navigate).toHaveBeenLastCalledWith(tab.id, { action: 'back' }, signal)
    await expect(run(tools.browser_navigate, { tabId: tab.id, action: 'navigate' })).rejects.toThrow('Provide url')
  })

  it('allows opening a blank tab but rejects about:blank navigation before execution', async () => {
    const { controller, tools } = setup()
    await run(tools.browser_tabs, { action: 'open', url: 'about:blank' })
    expect(controller.openTab).toHaveBeenCalledWith('about:blank', undefined)
    await expect(
      run(tools.browser_navigate, { tabId: tab.id, action: 'navigate', url: 'about:blank' }),
    ).rejects.toThrow('HTTP or HTTPS')
    expect(controller.navigate).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'example.com'])(
    'rejects unsafe or ambiguous navigation URL %s',
    async (url) => {
      const { controller, tools } = setup()
      await expect(run(tools.browser_tabs, { action: 'open', url })).rejects.toThrow()
      await expect(run(tools.browser_navigate, { tabId: tab.id, action: 'navigate', url })).rejects.toThrow()
      expect(controller.openTab).not.toHaveBeenCalled()
      expect(controller.navigate).not.toHaveBeenCalled()
    },
  )

  it('forwards reference and coordinate actions without caching side effects', async () => {
    const { controller, tools } = setup()
    const signal = new AbortController().signal
    const input = { tabId: tab.id, type: 'click', ref: 'document-1:1' }
    await run(tools.browser_action, input, signal)
    await run(tools.browser_action, input, signal)
    expect(controller.act).toHaveBeenCalledTimes(2)
    expect(controller.act).toHaveBeenCalledWith(tab.id, { type: 'click', ref: 'document-1:1' }, signal)
    await run(tools.browser_action, { tabId: tab.id, type: 'move', x: 20, y: 30 }, signal)
    expect(controller.act).toHaveBeenLastCalledWith(tab.id, { type: 'move', x: 20, y: 30 }, signal)
  })

  it('passes text, keys and scrolls as structured browser actions', async () => {
    const { controller, tools } = setup()
    await run(tools.browser_action, {
      tabId: tab.id,
      type: 'type',
      text: 'Hello $world',
      ref: 'document-1:2',
      clear: true,
    })
    expect(controller.act).toHaveBeenLastCalledWith(
      tab.id,
      { type: 'type', text: 'Hello $world', ref: 'document-1:2', clear: true },
      undefined,
    )
    await run(tools.browser_action, { tabId: tab.id, type: 'key', key: 'Enter' })
    expect(controller.act).toHaveBeenLastCalledWith(tab.id, { type: 'key', key: 'Enter' }, undefined)
    await run(tools.browser_action, { tabId: tab.id, type: 'scroll', deltaY: 450 })
    expect(controller.act).toHaveBeenLastCalledWith(
      tab.id,
      { type: 'scroll', x: undefined, y: undefined, deltaX: undefined, deltaY: 450 },
      undefined,
    )
  })

  it.each([
    { type: 'click' },
    { type: 'click', x: 10 },
    { type: 'click', ref: 'document-1:1', x: 10, y: 10 },
    { type: 'move', x: -1, y: 10 },
    { type: 'move', x: Number.POSITIVE_INFINITY, y: 10 },
    { type: 'type' },
    { type: 'type', text: 'x'.repeat(20_001) },
    { type: 'key' },
    { type: 'scroll' },
    { type: 'scroll', deltaY: 100_001 },
  ])('rejects invalid action before execution ($type)', async (action) => {
    const { controller, tools } = setup()
    await expect(run(tools.browser_action, { tabId: tab.id, ...action })).rejects.toThrow()
    expect(controller.act).not.toHaveBeenCalled()
  })

  it.each([
    ['browser_tabs', { action: 'open', url: tab.url }],
    ['browser_snapshot', { tabId: tab.id }],
    ['browser_navigate', { tabId: tab.id, action: 'back' }],
    ['browser_action', { tabId: tab.id, type: 'key', key: 'Enter' }],
  ] as const)('does not start %s after the user stops the turn', async (name, input) => {
    const { controller, tools } = setup()
    const abort = new AbortController()
    abort.abort()
    await expect(run(tools[name], input, abort.signal)).rejects.toThrow()
    for (const method of Object.values(controller)) {
      expect(method).not.toHaveBeenCalled()
    }
  })

  it('propagates native action failures instead of claiming success', async () => {
    const { controller, tools } = setup()
    controller.act.mockRejectedValue(new Error('Element reference is stale'))
    await expect(run(tools.browser_action, { tabId: tab.id, type: 'click', ref: 'old:1' })).rejects.toThrow('stale')
  })
})

describe('browser screenshot model output', () => {
  it('includes image dimensions for mapping high-density screenshots to CSS coordinates', () => {
    const output = {
      ...page,
      screenshot: { data: 'PNG_BYTES', mediaType: 'image/png' as const, width: 1600, height: 1200 },
    }
    const result = browserSnapshotModelOutput({ output })
    expect(result.value[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ ...page, screenshotSize: { width: 1600, height: 1200 } }),
    })
  })
  it('separates the screenshot from page JSON so both agent engines receive an image', () => {
    const output = { ...page, screenshot: { data: 'PNG_BYTES', mediaType: 'image/png' as const } }
    expect(browserSnapshotModelOutput({ output })).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: JSON.stringify(page) },
        { type: 'image-data', data: 'PNG_BYTES', mediaType: 'image/png' },
      ],
    })
  })

  it('keeps document identity and warnings visible without a screenshot', () => {
    const output = { ...page, warnings: ['A cross-origin frame could not be inspected.'] }
    expect(browserSnapshotModelOutput({ output })).toEqual({
      type: 'content',
      value: [{ type: 'text', text: JSON.stringify(output) }],
    })
  })
})
