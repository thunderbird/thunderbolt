/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as tauriCore from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import * as platform from '@/lib/platform'
import { getClock } from '@/testing-library'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { type RefObject } from 'react'
import {
  getBrowserClip,
  useSidebarWebview,
  type SidebarBrowserState,
  type SidebarWebviewConfig,
} from './use-sidebar-webview'

type IpcCall = { command: string; args: Record<string, unknown> }
const calls: IpcCall[] = []
let labels: string[] = []
let nativeState: SidebarBrowserState
let createResponse: (label: string) => Promise<void>
let stateResponse: (label: string) => Promise<SidebarBrowserState>
let actionResponse: () => Promise<void>
let presentationResponse: (command: string, label: string) => Promise<void>
let invokeSpy: ReturnType<typeof spyOn<typeof tauriCore, 'invoke'>>
let platformSpy: ReturnType<typeof spyOn<typeof platform, 'isTauriDesktop'>>
let resizeCallback: ResizeObserverCallback
const disconnect = mock(() => {})
const defaultUrl = 'https://example.com/'
const defaultConfig = { url: defaultUrl }

/** Creates a measured page viewport beneath the toolbar. */
const createViewport = (width = 400, height = 600) => {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => new DOMRect(50, 100, width, height)
  return { current: container } as RefObject<HTMLDivElement>
}

/** Advances initialization without running the recurring engine-state polling forever. */
const initialize = async () => {
  await act(async () => {
    await getClock().tickAsync(20)
  })
}

const matchingCalls = (command: string) => calls.filter((call) => call.command === command)
const visibilityCalls = (hidden: boolean) =>
  matchingCalls('browser_set_visibility').filter((call) => call.args.hidden === hidden)

beforeEach(() => {
  calls.length = 0
  labels = []
  nativeState = { url: defaultUrl, title: 'Example', isLoading: false, canGoBack: false, canGoForward: false }
  createResponse = async () => {}
  stateResponse = async () => ({ ...nativeState })
  actionResponse = async () => {}
  presentationResponse = async () => {}
  platformSpy = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  disconnect.mockClear()
  global.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback
    }
    observe() {}
    unobserve() {}
    disconnect = disconnect
  }
  mockWindows('main')
  mockIPC(
    async (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>
      calls.push({ command, args })
      switch (command) {
        case 'plugin:webview|webview_position':
          return { x: 20, y: 60 }
        case 'plugin:window|scale_factor':
          return 2
        case 'browser_create':
          await createResponse(args.label as string)
          labels.push(args.label as string)
          nativeState.url = args.url as string
          return
        case 'browser_get_state':
          return stateResponse(args.label as string)
        case 'browser_navigate':
          await actionResponse()
          nativeState = { ...nativeState, url: args.url as string, canGoBack: true, canGoForward: false }
          return
        case 'browser_action':
          await actionResponse()
          return
        case 'browser_close':
          labels = labels.filter((label) => label !== args.label)
          return
        case 'browser_resize_raise':
          return presentationResponse(command, 'browser-resize-handle')
        case 'plugin:webview|get_all_webviews':
          return labels.map((label) => ({ label, windowLabel: 'main' }))
        case 'browser_present':
        case 'browser_set_visibility':
          return presentationResponse(command, args.label as string)
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
  platformSpy.mockRestore()
  invokeSpy.mockRestore()
  clearMocks()
})

describe('useSidebarWebview', () => {
  it('does not report a page failure when the optional resize grip cannot be raised', async () => {
    presentationResponse = async (command) => {
      if (command === 'browser_resize_raise') {
        throw new Error('Command not found')
      }
    }
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const viewport = createViewport()
      const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
      await initialize()
      expect(matchingCalls('browser_resize_raise')).toHaveLength(1)
      expect(result.current.isInitialized).toBe(true)
      expect(result.current.error).toBeNull()
      expect(visibilityCalls(false)).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })

  it('does not create a browser without a URL, viewport, or desktop runtime', async () => {
    const viewport = createViewport()
    renderHook(() => useSidebarWebview(null, viewport))
    renderHook(() => useSidebarWebview(defaultConfig, { current: null }))
    platformSpy.mockReturnValue(false)
    renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    expect(matchingCalls('browser_create')).toHaveLength(0)
  })

  it('converts the native webview origin from physical pixels and reads real page state', async () => {
    const viewport = createViewport()
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    expect(result.current.isInitialized).toBe(false)
    await initialize()
    expect(matchingCalls('browser_create')[0]?.args).toMatchObject({
      url: defaultUrl,
      bounds: { x: 60, y: 130, width: 400, height: 600 },
      hidden: true,
    })
    expect(result.current).toMatchObject({ ...nativeState, isInitialized: true, error: null })
    expect(result.current.webview?.label).toBe(matchingCalls('browser_create')[0]?.args.label as string)
  })

  it('clamps collapsed viewport sizes and resizes below dynamically sized browser chrome', async () => {
    const viewport = createViewport(0, 0)
    renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    expect(matchingCalls('browser_create')[0]?.args).toMatchObject({ bounds: { width: 1, height: 1 } })
    viewport.current.getBoundingClientRect = () => new DOMRect(65, 170, 550, 400)
    await act(async () => {
      resizeCallback([], {} as ResizeObserver)
      await getClock().tickAsync(20)
    })
    expect(matchingCalls('browser_present').at(-1)?.args).toMatchObject({
      bounds: { x: 75, y: 200, width: 550, height: 400 },
      clip: { top: 0, right: 0, bottom: 0, left: 0 },
    })
  })

  it('navigates changed chat links in the same native webview and preserves history', async () => {
    const viewport = createViewport()
    const { result, rerender } = renderHook(({ config }) => useSidebarWebview(config, viewport), {
      initialProps: { config: defaultConfig },
    })
    await initialize()
    const originalWebview = result.current.webview
    rerender({ config: { url: 'https://mozilla.org/' } })
    await act(async () => {})
    expect(matchingCalls('browser_create')).toHaveLength(1)
    expect(matchingCalls('browser_close')).toHaveLength(0)
    expect(result.current.webview).toBe(originalWebview)
    expect(result.current.url).toBe('https://mozilla.org/')
    expect(result.current.canGoBack).toBe(true)
  })

  it('revisits the same chat link when a new config explicitly opens it again', async () => {
    const viewport = createViewport()
    const { result, rerender } = renderHook(({ config }) => useSidebarWebview(config, viewport), {
      initialProps: { config: defaultConfig },
    })
    await initialize()
    await act(async () => {
      await result.current.navigate('https://mozilla.org/')
    })
    rerender({ config: { url: defaultUrl } })
    await act(async () => {})
    expect(result.current.url).toBe(defaultUrl)
    expect(matchingCalls('browser_create')).toHaveLength(1)
  })

  it('updates redirects, page titles, loading and history from the engine', async () => {
    const viewport = createViewport()
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    nativeState = {
      url: 'https://example.com/redirected#section',
      title: 'A different page',
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
    }
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(result.current).toMatchObject(nativeState)
  })

  it('routes browser controls to native history instead of recreating the view', async () => {
    const viewport = createViewport()
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    await act(async () => {
      expect(await result.current.navigate('http://localhost:3000/')).toBe(true)
      await result.current.goBack()
      await result.current.goForward()
      await result.current.reload()
      await result.current.stop()
    })
    expect(matchingCalls('browser_action').map((call) => call.args.action)).toEqual([
      'back',
      'forward',
      'reload',
      'stop',
    ])
    expect(matchingCalls('browser_create')).toHaveLength(1)
    expect(result.current.url).toBe('http://localhost:3000/')
  })

  it('reports navigation failures without replacing the active URL, then recovers on retry', async () => {
    const viewport = createViewport()
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    actionResponse = async () => {
      throw new Error('Unsupported URL scheme')
    }
    await act(async () => {
      expect(await result.current.navigate('javascript:alert(1)')).toBe(false)
    })
    expect(result.current.error).toContain('Unsupported URL scheme')
    expect(result.current.url).toBe(defaultUrl)
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(result.current.error).toContain('Unsupported URL scheme')
    actionResponse = async () => {}
    await act(async () => {
      expect(await result.current.reload()).toBe(true)
    })
    expect(result.current.error).toBeNull()
  })

  it('clears a transient engine-poll failure after a successful read', async () => {
    const viewport = createViewport()
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    stateResponse = async () => {
      throw new Error('Document is replacing itself')
    }
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(result.current.error).toContain('Document is replacing itself')
    stateResponse = async () => ({ ...nativeState, title: 'Loaded normally' })
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.title).toBe('Loaded normally')
  })

  it('synchronizes a freshly loaded page and blank-page visibility before an agent observes it', async () => {
    const viewport = createViewport()
    const config = { url: 'about:blank' }
    const onStateChange = mock((_state: SidebarBrowserState) => {})
    const { result } = renderHook(() => useSidebarWebview(config, viewport, false, { onStateChange }))
    await initialize()
    expect(visibilityCalls(false)).toHaveLength(0)
    nativeState = { ...nativeState, url: defaultUrl, title: 'New destination' }
    await act(async () => {
      expect(await result.current.readState()).toEqual(nativeState)
    })
    expect(result.current.url).toBe(defaultUrl)
    expect(onStateChange).toHaveBeenLastCalledWith(nativeState)
    expect(visibilityCalls(false)).toHaveLength(1)
  })

  it('does not return stale engine state when a newer navigation supersedes an agent read', async () => {
    const viewport = createViewport()
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    const response = Promise.withResolvers<SidebarBrowserState>()
    const oldState = nativeState
    stateResponse = () => response.promise
    const read = result.current.readState()
    stateResponse = async () => nativeState
    await act(async () => {
      await result.current.navigate('https://destination.example')
      response.resolve(oldState)
    })
    expect(await read).toBeUndefined()
    expect(result.current.url).toBe('https://destination.example')
  })

  it('retries a failed creation using reload', async () => {
    const viewport = createViewport()
    createResponse = async () => {
      throw new Error('Unable to create webview')
    }
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    expect(result.current.isInitialized).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toContain('Unable to create webview')
    createResponse = async () => {}
    await act(async () => {
      await result.current.reload()
    })
    await initialize()
    expect(result.current.isInitialized).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('discards a stale engine poll when navigation starts while that poll is pending', async () => {
    const viewport = createViewport()
    const onStateChange = mock((_state: SidebarBrowserState) => {})
    const { result } = renderHook(() => useSidebarWebview(defaultConfig, viewport, false, { onStateChange }))
    await initialize()
    const pendingState = Promise.withResolvers<SidebarBrowserState>()
    const oldState = { ...nativeState }
    stateResponse = () => pendingState.promise
    await act(async () => {
      await getClock().tickAsync(500)
    })
    stateResponse = async () => ({ ...nativeState })
    await act(async () => {
      await result.current.navigate('https://mozilla.org/')
      pendingState.resolve(oldState)
      await Promise.resolve()
    })
    expect(result.current.url).toBe('https://mozilla.org/')
    expect(onStateChange.mock.calls.at(-1)?.[0].url).toBe('https://mozilla.org/')
    expect(onStateChange.mock.calls.map(([state]) => state.url)).toEqual([defaultUrl, 'https://mozilla.org/'])
  })

  it('publishes native state to the latest callback without recreating its tab', async () => {
    const viewport = createViewport()
    const originalCallback = mock((_state: SidebarBrowserState) => {})
    const latestCallback = mock((_state: SidebarBrowserState) => {})
    const { rerender } = renderHook(
      ({ onStateChange }) => useSidebarWebview(defaultConfig, viewport, false, { onStateChange }),
      { initialProps: { onStateChange: originalCallback } },
    )
    await initialize()
    rerender({ onStateChange: latestCallback })
    nativeState = { ...nativeState, title: 'Updated title' }
    await act(async () => {
      await getClock().tickAsync(500)
    })
    expect(matchingCalls('browser_create')).toHaveLength(1)
    expect(originalCallback).toHaveBeenCalledTimes(1)
    expect(latestCallback).toHaveBeenCalledWith(nativeState)
  })

  it('handles early page popups before native creation finishes and uses the latest callback', async () => {
    const viewport = createViewport()
    const pendingCreate = Promise.withResolvers<void>()
    const originalCallback = mock((_url: string) => {})
    const latestCallback = mock((_url: string) => {})
    const popupUrl = 'https://example.com/popup'
    createResponse = async (label) => {
      await emit('browser-new-tab', { label, url: popupUrl })
      await pendingCreate.promise
    }
    const { result, rerender, unmount } = renderHook(
      ({ onNewTab }) => useSidebarWebview(defaultConfig, viewport, false, { onNewTab }),
      { initialProps: { onNewTab: originalCallback } },
    )
    await initialize()
    expect(result.current.isInitialized).toBe(false)
    expect(originalCallback).toHaveBeenCalledWith(popupUrl)
    const label = matchingCalls('browser_create')[0]?.args.label as string
    rerender({ onNewTab: latestCallback })
    await act(async () => {
      await emit('browser-new-tab', { label: 'sidebar-webview-another-tab', url: popupUrl })
      await emit('browser-new-tab', { label, url: popupUrl })
      pendingCreate.resolve()
    })
    expect(latestCallback).toHaveBeenCalledTimes(1)
    expect(matchingCalls('browser_create')).toHaveLength(1)
    unmount()
    await act(async () => {
      await emit('browser-new-tab', { label, url: popupUrl })
    })
    expect(latestCallback).toHaveBeenCalledTimes(1)
    expect(
      invokeSpy.mock.calls.some(
        ([command, args]) =>
          command === 'plugin:event|unlisten' && (args as { event?: string }).event === 'browser-new-tab',
      ),
    ).toBe(true)
  })

  it('removes an event subscription completed after the tab is closed without creating a native page', async () => {
    const viewport = createViewport()
    const pendingListen = Promise.withResolvers<void>()
    const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: typeof tauriCore.invoke }
    invokeSpy.mockImplementation(async (command, args) => {
      if (command === 'plugin:event|listen' && (args as { event?: string }).event === 'browser-new-tab') {
        await pendingListen.promise
      }
      return internals.invoke(command, args)
    })
    const { unmount } = renderHook(() => useSidebarWebview(defaultConfig, viewport))
    await initialize()
    unmount()
    await act(async () => {
      pendingListen.resolve()
    })
    expect(matchingCalls('browser_create')).toHaveLength(0)
    expect(
      invokeSpy.mock.calls.filter(
        ([command, args]) =>
          command === 'plugin:event|unlisten' && (args as { event?: string }).event === 'browser-new-tab',
      ),
    ).toHaveLength(1)
  })

  it('preserves separate native pages and history while switching and closing tabs', async () => {
    const firstViewport = createViewport()
    const secondViewport = createViewport()
    const secondConfig = { url: 'https://mozilla.org/' }
    const firstState = { ...nativeState, title: 'First tab', canGoBack: true }
    const secondState = { ...nativeState, url: secondConfig.url, title: 'Second tab', canGoForward: true }
    stateResponse = async (label) => (label === labels[0] ? firstState : secondState)
    const first = renderHook(({ hidden }) => useSidebarWebview(defaultConfig, firstViewport, hidden), {
      initialProps: { hidden: false },
    })
    const second = renderHook(({ hidden }) => useSidebarWebview(secondConfig, secondViewport, hidden), {
      initialProps: { hidden: true },
    })
    await initialize()
    const firstLabel = first.result.current.webview?.label
    const secondLabel = second.result.current.webview?.label
    expect(firstLabel).not.toBe(secondLabel)
    expect(first.result.current).toMatchObject(firstState)
    expect(second.result.current).toMatchObject(secondState)
    first.rerender({ hidden: true })
    second.rerender({ hidden: false })
    await act(async () => {})
    expect(visibilityCalls(true).at(-1)?.args.label).toBe(firstLabel)
    expect(visibilityCalls(false).at(-1)?.args.label).toBe(secondLabel)
    await act(async () => {
      await first.result.current.goBack()
      await second.result.current.goForward()
    })
    expect(matchingCalls('browser_action').map(({ args }) => args)).toEqual([
      { label: firstLabel, action: 'back' },
      { label: secondLabel, action: 'forward' },
    ])
    first.unmount()
    await act(async () => {})
    expect(matchingCalls('browser_close').map(({ args }) => args.label)).toEqual([firstLabel])
    expect(second.result.current.webview?.label).toBe(secondLabel)
    expect(second.result.current).toMatchObject(secondState)
    expect(matchingCalls('browser_create')).toHaveLength(2)
  })

  it('applies new bounds before showing a tab and cancels stale shows during rapid switches', async () => {
    const viewport = createViewport()
    const { rerender } = renderHook(({ hidden }) => useSidebarWebview(defaultConfig, viewport, hidden), {
      initialProps: { hidden: true },
    })
    await initialize()
    calls.length = 0
    const pendingPosition = Promise.withResolvers<void>()
    presentationResponse = async (command) => {
      if (command === 'browser_present') {
        await pendingPosition.promise
      }
    }
    viewport.current.getBoundingClientRect = () => new DOMRect(65, 170, 550, 400)
    rerender({ hidden: false })
    await act(async () => {})
    expect(visibilityCalls(false)).toHaveLength(0)
    rerender({ hidden: true })
    await act(async () => {
      pendingPosition.resolve()
    })
    expect(visibilityCalls(false)).toHaveLength(0)
    rerender({ hidden: false })
    await act(async () => {})
    const sizeIndex = calls.findLastIndex(({ command }) => command === 'browser_present')
    const showIndex = calls.findLastIndex(
      ({ command, args }) => command === 'browser_set_visibility' && args.hidden === false,
    )
    expect(sizeIndex).toBeLessThan(showIndex)
    expect(calls[sizeIndex]?.args).toMatchObject({
      bounds: { width: 550, height: 400 },
    })
    expect(matchingCalls('browser_create')).toHaveLength(0)
    expect(matchingCalls('browser_close')).toHaveLength(0)
  })

  it('uses the latest URL and visibility if props change during native creation', async () => {
    const viewport = createViewport()
    const pendingCreate = Promise.withResolvers<void>()
    createResponse = () => pendingCreate.promise
    const { result, rerender } = renderHook(({ config, hidden }) => useSidebarWebview(config, viewport, hidden), {
      initialProps: { config: defaultConfig, hidden: false },
    })
    await initialize()
    rerender({ config: { url: 'https://mozilla.org/' }, hidden: true })
    await act(async () => {
      pendingCreate.resolve()
    })
    expect(result.current.url).toBe('https://mozilla.org/')
    expect(matchingCalls('browser_create')).toHaveLength(1)
    expect(visibilityCalls(true)).toHaveLength(1)
  })

  it('hides and shows the native page when dialogs cover it', async () => {
    const viewport = createViewport()
    const { rerender } = renderHook(({ hidden }) => useSidebarWebview(defaultConfig, viewport, hidden), {
      initialProps: { hidden: true },
    })
    await initialize()
    expect(matchingCalls('browser_create')[0]?.args.hidden).toBe(true)
    expect(visibilityCalls(true)).toHaveLength(1)
    rerender({ hidden: false })
    await act(async () => {})
    expect(visibilityCalls(false)).toHaveLength(1)
  })

  it('keeps the native new-tab page hidden until navigation and hides it again after back', async () => {
    const viewport = createViewport()
    const config = { url: 'about:blank' }
    const { result, rerender } = renderHook(({ hidden }) => useSidebarWebview(config, viewport, hidden), {
      initialProps: { hidden: false },
    })
    await initialize()
    expect(result.current.isInitialized).toBe(true)
    expect(result.current.url).toBe('about:blank')
    expect(matchingCalls('browser_create')[0]?.args.hidden).toBe(true)
    expect(visibilityCalls(false)).toHaveLength(0)
    rerender({ hidden: true })
    await act(async () => {})
    rerender({ hidden: false })
    await act(async () => {})
    expect(visibilityCalls(false)).toHaveLength(0)
    await act(async () => {
      await result.current.navigate(defaultUrl)
    })
    expect(visibilityCalls(false)).toHaveLength(1)
    expect(result.current.url).toBe(defaultUrl)
    expect(result.current.canGoBack).toBe(true)
    const sizeIndex = calls.findLastIndex(({ command }) => command === 'browser_present')
    const showIndex = calls.findLastIndex(
      ({ command, args }) => command === 'browser_set_visibility' && args.hidden === false,
    )
    expect(sizeIndex).toBeLessThan(showIndex)
    actionResponse = async () => {
      nativeState = { ...nativeState, url: 'about:blank', canGoBack: false, canGoForward: true }
    }
    await act(async () => {
      await result.current.goBack()
    })
    expect(result.current.url).toBe('about:blank')
    expect(calls.at(-1)).toMatchObject({ command: 'browser_set_visibility', args: { hidden: true } })
    expect(matchingCalls('browser_create')).toHaveLength(1)
  })

  it('does not reveal a background new tab when its first page loads', async () => {
    const viewport = createViewport()
    const config = { url: 'about:blank' }
    const { result, rerender } = renderHook(({ hidden }) => useSidebarWebview(config, viewport, hidden), {
      initialProps: { hidden: true },
    })
    await initialize()
    await act(async () => {
      await result.current.navigate(defaultUrl)
    })
    expect(result.current.url).toBe(defaultUrl)
    expect(visibilityCalls(false)).toHaveLength(0)
    rerender({ hidden: false })
    await act(async () => {})
    expect(visibilityCalls(false)).toHaveLength(1)
  })

  it('does not re-hide a navigated new tab when a poll started during navigation finishes late', async () => {
    const viewport = createViewport()
    const config = { url: 'about:blank' }
    const { result } = renderHook(() => useSidebarWebview(config, viewport))
    await initialize()
    const oldState = { ...nativeState }
    const pendingAction = Promise.withResolvers<void>()
    const pendingPoll = Promise.withResolvers<SidebarBrowserState>()
    actionResponse = () => pendingAction.promise
    const navigation = result.current.navigate(defaultUrl)
    stateResponse = () => pendingPoll.promise
    await act(async () => {
      await getClock().tickAsync(500)
    })
    stateResponse = async () => ({ ...nativeState })
    await act(async () => {
      pendingAction.resolve()
      await navigation
    })
    expect(result.current.url).toBe(defaultUrl)
    const hideCount = visibilityCalls(true).length
    await act(async () => {
      pendingPoll.resolve(oldState)
    })
    expect(result.current.url).toBe(defaultUrl)
    expect(visibilityCalls(true)).toHaveLength(hideCount)
  })

  it('closes a browser created after unmount without publishing stale initialized state', async () => {
    const viewport = createViewport()
    const pendingCreate = Promise.withResolvers<void>()
    createResponse = () => pendingCreate.promise
    const onStateChange = mock(() => {})
    const { unmount } = renderHook(() => useSidebarWebview(defaultConfig, viewport, false, { onStateChange }))
    await initialize()
    unmount()
    await act(async () => {
      pendingCreate.resolve()
    })
    expect(matchingCalls('browser_close')).toHaveLength(1)
    expect(matchingCalls('browser_get_state')).toHaveLength(0)
    expect(onStateChange).not.toHaveBeenCalled()
  })

  it('does not publish an in-flight native poll after its tab is closed', async () => {
    const viewport = createViewport()
    const onStateChange = mock(() => {})
    const { unmount } = renderHook(() => useSidebarWebview(defaultConfig, viewport, false, { onStateChange }))
    await initialize()
    const pendingState = Promise.withResolvers<SidebarBrowserState>()
    stateResponse = () => pendingState.promise
    await act(async () => {
      await getClock().tickAsync(500)
    })
    unmount()
    await act(async () => {
      pendingState.resolve({ ...nativeState, title: 'Too late' })
    })
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(matchingCalls('browser_close')).toHaveLength(1)
  })

  it('closes once, stops polling and invokes the latest onClose callback', async () => {
    const viewport = createViewport()
    const originalClose = mock(() => {})
    const latestClose = mock(() => {})
    const { result, rerender, unmount } = renderHook(
      ({ config }: { config: SidebarWebviewConfig }) => useSidebarWebview(config, viewport),
      { initialProps: { config: { url: defaultUrl, onClose: originalClose } } },
    )
    await initialize()
    rerender({ config: { url: defaultUrl, onClose: latestClose } })
    await act(async () => {
      await Promise.all([result.current.closeWebview(), result.current.closeWebview()])
    })
    const stateReads = matchingCalls('browser_get_state').length
    unmount()
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(matchingCalls('browser_close')).toHaveLength(1)
    expect(matchingCalls('browser_get_state')).toHaveLength(stateReads)
    expect(originalClose).not.toHaveBeenCalled()
    expect(latestClose).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalled()
  })
})

describe('getBrowserClip', () => {
  it('sends clipped insets without shrinking the document viewport', () => {
    const host = document.createElement('div')
    host.dataset.pageHost = 'inline'
    host.style.clipPath = 'inset(120px 8px 40px 10px)'
    const viewport = createViewport()
    host.append(viewport.current)
    document.body.append(host)
    try {
      expect(getBrowserClip(viewport.current)).toEqual({ top: 120, right: 8, bottom: 40, left: 10 })
      expect(viewport.current.getBoundingClientRect().height).toBe(600)
    } finally {
      host.remove()
    }
  })
})
