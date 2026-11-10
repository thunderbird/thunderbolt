/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as tauriCore from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { Webview } from '@tauri-apps/api/webview'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { useBrowserShortcuts } from './use-browser-shortcuts'
import type { useSidebarWebview } from './use-sidebar-webview'

const label = 'sidebar-webview-test'
const configurations: Record<string, unknown>[] = []
const reload = mock(async () => true)
const goBack = mock(async () => true)
const goForward = mock(async () => true)
const tabActions = {
  onNewTab: mock(() => {}),
  onCloseTab: mock(() => {}),
  onNextTab: mock(() => {}),
  onPreviousTab: mock(() => {}),
}
let invokeSpy: ReturnType<typeof spyOn<typeof tauriCore, 'invoke'>>
let browser: ReturnType<typeof useSidebarWebview>
let addressRef: { current: HTMLInputElement }

beforeEach(() => {
  configurations.length = 0
  for (const callback of [reload, goBack, goForward, ...Object.values(tabActions)]) {
    callback.mockClear()
  }
  browser = {
    webview: { label } as Webview,
    isInitialized: true,
    url: 'https://example.com/',
    title: 'Example',
    isLoading: false,
    canGoBack: true,
    canGoForward: false,
    error: null,
    navigate: async () => true,
    reload,
    goBack,
    goForward,
    stop: async () => true,
    closeWebview: async () => {},
  }
  addressRef = { current: document.createElement('input') }
  addressRef.current.value = browser.url
  document.body.append(addressRef.current)
  mockWindows('main')
  mockIPC(
    (command, args) => {
      if (command === 'browser_configure_shortcuts') {
        configurations.push((args as { config: Record<string, unknown> }).config)
      }
    },
    { shouldMockEvents: true },
  )
  const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: typeof tauriCore.invoke }
  invokeSpy = spyOn(tauriCore, 'invoke').mockImplementation(internals.invoke)
  invokeSpy.mockClear()
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  addressRef.current.remove()
  invokeSpy.mockRestore()
  clearMocks()
})

/** Simulates a trusted native menu accelerator delivered while the child page has keyboard focus. */
const shortcut = async (action: string, target = label) => {
  await act(async () => {
    await emit('browser-shortcut', { label: target, action })
  })
}

describe('useBrowserShortcuts', () => {
  it('configures localized native menu controls and disables them when a dialog covers the browser', async () => {
    const { rerender, unmount } = renderHook(
      ({ hidden }) => useBrowserShortcuts({ browser, addressRef, hidden, ...tabActions }),
      {
        initialProps: { hidden: false },
      },
    )
    await act(async () => {})
    expect(configurations.at(-1)).toMatchObject({
      label,
      enabled: true,
      canGoBack: true,
      canGoForward: false,
      labels: {
        browser: 'Browser',
        focusAddress: 'Focus address bar',
        newTab: 'New tab',
        closeTab: 'Close tab',
        nextTab: 'Next tab',
        previousTab: 'Previous tab',
      },
    })
    rerender({ hidden: true })
    await act(async () => {})
    expect(configurations.at(-1)?.enabled).toBe(false)
    await shortcut('reload')
    expect(reload).not.toHaveBeenCalled()
    unmount()
    expect(configurations.at(-1)).toMatchObject({ label, enabled: false })
  })

  it('selects the address and dispatches browser actions from native menu events', async () => {
    renderHook(() => useBrowserShortcuts({ browser, addressRef, ...tabActions }))
    await act(async () => {})
    await shortcut('focus-address')
    expect(document.activeElement).toBe(addressRef.current)
    expect(addressRef.current.selectionStart).toBe(0)
    expect(addressRef.current.selectionEnd).toBe(browser.url.length)
    await shortcut('reload')
    await shortcut('back')
    await shortcut('forward')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(goBack).toHaveBeenCalledTimes(1)
    expect(goForward).not.toHaveBeenCalled()
  })

  it('ignores stale events from a different browser and unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useBrowserShortcuts({ browser, addressRef, ...tabActions }))
    await act(async () => {})
    await shortcut('reload', 'sidebar-webview-old')
    expect(reload).not.toHaveBeenCalled()
    unmount()
    await shortcut('reload')
    expect(reload).not.toHaveBeenCalled()
  })

  it('dispatches tab shortcuts only for the active visible tab', async () => {
    const { rerender } = renderHook(
      ({ hidden }) => useBrowserShortcuts({ browser, addressRef, hidden, ...tabActions }),
      { initialProps: { hidden: false } },
    )
    await act(async () => {})
    for (const action of ['new-tab', 'close-tab', 'next-tab', 'previous-tab']) {
      await shortcut(action)
    }
    for (const callback of Object.values(tabActions)) {
      expect(callback).toHaveBeenCalledTimes(1)
    }
    rerender({ hidden: true })
    await act(async () => {})
    for (const action of ['new-tab', 'close-tab', 'next-tab', 'previous-tab']) {
      await shortcut(action)
    }
    for (const callback of Object.values(tabActions)) {
      expect(callback).toHaveBeenCalledTimes(1)
    }
  })

  it('routes shortcuts to the latest tab callbacks without resubscribing', async () => {
    const onNewTab = mock(() => {})
    const { rerender } = renderHook(({ callbacks }) => useBrowserShortcuts({ browser, addressRef, ...callbacks }), {
      initialProps: { callbacks: tabActions },
    })
    await act(async () => {})
    rerender({ callbacks: { ...tabActions, onNewTab } })
    await shortcut('new-tab')
    expect(onNewTab).toHaveBeenCalledTimes(1)
    expect(tabActions.onNewTab).not.toHaveBeenCalled()
  })
})
