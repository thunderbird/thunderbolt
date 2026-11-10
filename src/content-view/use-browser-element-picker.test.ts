/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as tauriCore from '@tauri-apps/api/core'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { getClock } from '@/testing-library'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { useBrowserElementPicker } from './use-browser-element-picker'

const label = 'sidebar-webview-picked'
const url = 'https://example.com/'
const initialProps = { tabId: 'tab-one', label, url, chatThreadId: 'chat-one', enabled: true }
const selection = {
  url,
  title: 'Example',
  element: {
    id: 'document-one:element-one',
    label: 'Continue',
    text: 'Continue to the next step',
    rect: { x: 10, y: 20, width: 100, height: 30 },
  },
}
type DeferredPoll = { resolve: (value: unknown) => void; reject: (error: Error) => void }
const polls: DeferredPoll[] = []
const calls: { command: string; args: Record<string, unknown> }[] = []
let invokeSpy: ReturnType<typeof spyOn<typeof tauriCore, 'invoke'>>

beforeEach(() => {
  polls.length = 0
  calls.length = 0
  usePendingQuotesStore.setState({ quotesByThread: {} })
  mockIPC((command, payload) => {
    calls.push({ command, args: (payload ?? {}) as Record<string, unknown> })
    if (command === 'browser_poll_picker') {
      return new Promise((resolve, reject) => polls.push({ resolve, reject }))
    }
  })
  const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: typeof tauriCore.invoke }
  invokeSpy = spyOn(tauriCore, 'invoke').mockImplementation(internals.invoke)
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  invokeSpy.mockRestore()
  clearMocks()
  usePendingQuotesStore.setState({ quotesByThread: {} })
})

/** Start the gesture and settle its native activation before delivering a picker result. */
const start = async (result: { current: ReturnType<typeof useBrowserElementPicker> }) => {
  await act(async () => result.current.toggle())
}

describe('useBrowserElementPicker', () => {
  it('attaches one selection to its owning composer and stops the native picker', async () => {
    const onAttached = mock(() => {})
    const { result } = renderHook(() => useBrowserElementPicker({ ...initialProps, onAttached }))
    await start(result)
    expect(result.current.isPicking).toBe(true)
    expect(calls[0]).toMatchObject({ command: 'browser_set_picker', args: { label, enabled: true } })
    await act(async () => polls[0].resolve(selection))
    expect(result.current.isPicking).toBe(false)
    expect(usePendingQuotesStore.getState().quotesByThread['chat-one']).toHaveLength(1)
    expect(usePendingQuotesStore.getState().quotesByThread['chat-one'][0].data.text).toContain(selection.element.id)
    expect(usePendingQuotesStore.getState().quotesByThread['chat-one'][0].data.text).toContain('"tabId":"tab-one"')
    expect(onAttached).toHaveBeenCalledTimes(1)
    expect(calls.at(-1)).toEqual({
      command: 'browser_set_picker',
      args: { label, enabled: false, requestId: calls[0].args.requestId },
    })
  })

  it('cancels on Escape in the main webview before focus enters the native page', async () => {
    const { result } = renderHook(() => useBrowserElementPicker(initialProps))
    await start(result)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => {
      document.dispatchEvent(escape)
    })
    expect(escape.defaultPrevented).toBe(true)
    expect(result.current.isPicking).toBe(false)
    expect(calls.at(-1)).toEqual({
      command: 'browser_set_picker',
      args: { label, enabled: false, requestId: calls[0].args.requestId },
    })
    await act(async () => polls[0].resolve(selection))
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
    const idleEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    document.dispatchEvent(idleEscape)
    expect(idleEscape.defaultPrevented).toBe(false)
  })

  it('polls at a bounded interval while waiting and handles native Escape without attaching anything', async () => {
    const { result } = renderHook(() => useBrowserElementPicker(initialProps))
    await start(result)
    await act(async () => polls[0].resolve(null))
    await act(async () => getClock().tickAsync(149))
    expect(polls).toHaveLength(1)
    await act(async () => getClock().tickAsync(1))
    expect(polls).toHaveLength(2)
    await act(async () => polls[1].resolve({ cancelled: true }))
    expect(result.current.isPicking).toBe(false)
    expect(result.current.error).toBe(false)
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
  })

  it('ignores a cancelled gesture even if its result arrives after the next gesture starts', async () => {
    const { result } = renderHook(() => useBrowserElementPicker(initialProps))
    await start(result)
    await start(result)
    await start(result)
    expect(calls.filter((call) => call.command === 'browser_set_picker' && call.args.enabled)).toHaveLength(2)
    await act(async () => polls[0].resolve(selection))
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
    expect(result.current.isPicking).toBe(true)
    await act(async () => polls[1].resolve(selection))
    expect(usePendingQuotesStore.getState().quotesByThread['chat-one']).toHaveLength(1)
  })

  for (const change of [
    { chatThreadId: 'chat-two' },
    { label: 'sidebar-webview-other' },
    { url: 'https://example.com/next' },
    { enabled: false },
  ]) {
    it(`cancels a gesture when its ${Object.keys(change)[0]} changes`, async () => {
      const { result, rerender } = renderHook((props) => useBrowserElementPicker(props), { initialProps })
      await start(result)
      rerender({ ...initialProps, ...change })
      await act(async () => polls[0].resolve(selection))
      expect(result.current.isPicking).toBe(false)
      expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
    })
  }

  it('does not attach after unmount or after native navigation outruns the chrome', async () => {
    const first = renderHook(() => useBrowserElementPicker(initialProps))
    await start(first.result)
    first.unmount()
    await act(async () => polls[0].resolve(selection))
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
    const second = renderHook(() => useBrowserElementPicker(initialProps))
    await start(second.result)
    await act(async () => polls[1].resolve({ ...selection, url: 'https://example.com/next' }))
    expect(second.result.current.isPicking).toBe(false)
    expect(second.result.current.error).toBe(false)
    expect(usePendingQuotesStore.getState().quotesByThread).toEqual({})
  })

  it('surfaces driver failures and permits another attempt', async () => {
    const { result } = renderHook(() => useBrowserElementPicker(initialProps))
    await start(result)
    await act(async () => polls[0].reject(new Error('The page closed')))
    expect(result.current.error).toBe(true)
    expect(result.current.isPicking).toBe(false)
    await start(result)
    expect(result.current.error).toBe(false)
    await act(async () => polls[1].resolve(selection))
    expect(usePendingQuotesStore.getState().quotesByThread['chat-one']).toHaveLength(1)
  })

  it('cannot start without a chat, a live page, or a visible native tab', async () => {
    for (const unavailable of [{ chatThreadId: null }, { label: null }, { url: 'about:blank' }, { enabled: false }]) {
      const { result, unmount } = renderHook(() => useBrowserElementPicker({ ...initialProps, ...unavailable }))
      await start(result)
      expect(result.current.canPick).toBe(false)
      expect(result.current.isPicking).toBe(false)
      unmount()
    }
    expect(calls).toEqual([])
  })
})
