/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as platform from '@/lib/platform'
import { browserController } from '@/browser/browser-controller'
import { getClock } from '@/testing-library'
import * as tauriCore from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SidebarWebview } from './sidebar-webview'

type NativeTab = { history: string[]; index: number; visible: boolean }
type IpcCall = { command: string; args: Record<string, unknown> }
const nativeTabs = new Map<string, NativeTab>()
const calls: IpcCall[] = []
const firstUrl = 'https://first.example/'
const secondUrl = 'https://second.example/'
const popupUrl = 'https://popup.example/'
const defaultUrl = 'about:blank'
const config = { url: firstUrl }
const titles: Record<string, string> = {
  [firstUrl]: 'First page',
  [secondUrl]: 'Second page',
  [popupUrl]: 'Popup page',
  [defaultUrl]: '',
}
let invokeSpy: ReturnType<typeof spyOn<typeof tauriCore, 'invoke'>>
let platformSpy: ReturnType<typeof spyOn<typeof platform, 'isTauriDesktop'>>
let boundsSpy: ReturnType<typeof spyOn<HTMLElement, 'getBoundingClientRect'>>
let originalResizeObserver: typeof ResizeObserver

/** Read the chrome belonging to the selected tab, excluding inert background panels. */
const activePanel = () => {
  const panel = document.querySelector<HTMLElement>('[data-browser-tab-panel]:not([inert])')
  if (!panel) {
    throw new Error('Expected an active browser tab')
  }
  return within(panel)
}

/** Complete animation-frame initialization without exhausting recurring native-state polling. */
const initialize = async () => {
  await act(async () => {
    await getClock().tickAsync(20)
  })
}

/** Submit the visible address bar through the real browser chrome. */
const navigate = async (url: string) => {
  const input = activePanel().getByRole('textbox', { name: 'Address' })
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: url } })
  await act(async () => {
    fireEvent.click(activePanel().getByRole('button', { name: 'Go' }))
  })
}

/** Select an existing tab without recreating its native session. */
const selectTab = async (name: string) => {
  await act(async () => {
    const tab = activePanel().getByRole('tab', { name })
    tab.focus()
    fireEvent.click(tab)
  })
}

beforeEach(() => {
  nativeTabs.clear()
  calls.length = 0
  platformSpy = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  boundsSpy = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 150, 500, 600))
  originalResizeObserver = global.ResizeObserver
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  mockWindows('main')
  mockIPC(
    (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>
      calls.push({ command, args })
      const label = args.label as string
      const tab = nativeTabs.get(label)
      switch (command) {
        case 'plugin:webview|webview_position':
          return { x: 0, y: 0 }
        case 'plugin:window|scale_factor':
          return 1
        case 'browser_create':
          nativeTabs.set(label, { history: [args.url as string], index: 0, visible: !args.hidden })
          return
        case 'browser_get_state': {
          if (!tab) {
            throw new Error(`Missing native tab ${label}`)
          }
          const url = tab.history[tab.index]
          return {
            url,
            title: titles[url] ?? url,
            isLoading: false,
            canGoBack: tab.index > 0,
            canGoForward: tab.index < tab.history.length - 1,
          }
        }
        case 'browser_navigate':
          if (!tab) {
            throw new Error(`Missing native tab ${label}`)
          }
          tab.history = [...tab.history.slice(0, tab.index + 1), args.url as string]
          tab.index += 1
          return
        case 'browser_action':
          if (!tab) {
            throw new Error(`Missing native tab ${label}`)
          }
          if (args.action === 'back') {
            tab.index = Math.max(0, tab.index - 1)
          }
          if (args.action === 'forward') {
            tab.index = Math.min(tab.history.length - 1, tab.index + 1)
          }
          return
        case 'browser_close':
          nativeTabs.delete(label)
          return
        case 'plugin:webview|get_all_webviews':
          return [...nativeTabs.keys()].map((label) => ({ label, windowLabel: 'main' }))
        case 'browser_set_visibility':
          if (tab) {
            tab.visible = !args.hidden
          }
          return
        case 'plugin:webview|webview_show':
          if (tab) {
            tab.visible = true
          }
          return
        case 'plugin:webview|webview_hide':
          if (tab) {
            tab.visible = false
          }
          return
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
  boundsSpy.mockRestore()
  invokeSpy.mockRestore()
  global.ResizeObserver = originalResizeObserver
  clearMocks()
})

describe('SidebarWebview tabs', () => {
  it('preserves composer focus when the agent opens and closes a blank tab', async () => {
    const { getByRole } = render(
      <>
        <textarea aria-label="Chat composer" defaultValue="My unfinished draft" />
        <SidebarWebview config={config} />
      </>,
    )
    await initialize()
    const composer = getByRole('textbox', { name: 'Chat composer' })
    composer.focus()
    let opening: ReturnType<typeof browserController.openTab> | undefined
    await act(async () => {
      opening = browserController.openTab()
    })
    await initialize()
    await act(async () => {
      await getClock().tickAsync(100)
    })
    const opened = await opening!
    expect(opened.url).toBe('about:blank')
    expect(composer).toHaveFocus()
    expect(composer).toHaveValue('My unfinished draft')
    let closing: Promise<void> | undefined
    await act(async () => {
      closing = browserController.closeTab(opened.id)
    })
    await act(async () => {
      await getClock().tickAsync(100)
    })
    await closing
    expect(composer).toHaveFocus()
    expect(activePanel().getByRole('tab', { name: 'First page' })).toHaveAttribute('aria-selected', 'true')
  })

  it('creates independent native tabs and preserves page history when switching', async () => {
    render(<SidebarWebview config={config} />)
    await initialize()
    const firstLabel = [...nativeTabs.keys()][0]
    await navigate(secondUrl)
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue(secondUrl)

    fireEvent.click(activePanel().getByRole('button', { name: 'New tab' }))
    await initialize()
    const secondLabel = [...nativeTabs.keys()].find((label) => label !== firstLabel)
    expect(secondLabel).toBeDefined()
    expect(nativeTabs.size).toBe(2)
    expect(nativeTabs.get(firstLabel)?.visible).toBe(false)
    expect(nativeTabs.get(secondLabel!)?.visible).toBe(false)
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveFocus()
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue('')
    expect(activePanel().getByRole('img', { name: 'Thunderbolt' })).toBeInTheDocument()
    expect(activePanel().getByText('Enter a URL above or ask your agent to open a page.')).toBeInTheDocument()
    expect(activePanel().getAllByRole('textbox')).toHaveLength(1)
    expect(calls.filter(({ command }) => command === 'browser_configure_shortcuts').at(-1)?.args).toMatchObject({
      config: { label: secondLabel, enabled: true },
    })

    await selectTab('Second page')
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue(secondUrl)
    await act(async () => {
      fireEvent.click(activePanel().getByRole('button', { name: 'Go back' }))
    })
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue(firstUrl)
    expect(activePanel().getByRole('button', { name: 'Go forward' })).toBeEnabled()
    await selectTab('New tab')
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue('')
    expect(activePanel().getByRole('button', { name: 'Go back' })).toBeDisabled()
    expect(nativeTabs.get(firstLabel)?.history).toEqual([firstUrl, secondUrl])
    expect(nativeTabs.get(secondLabel!)?.history).toEqual([defaultUrl])
    await navigate(popupUrl)
    expect(nativeTabs.get(secondLabel!)?.visible).toBe(true)
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue(popupUrl)
    expect(activePanel().queryByText('Enter a URL above or ask your agent to open a page.')).toBeNull()
    await act(async () => {
      fireEvent.click(activePanel().getByRole('button', { name: 'Go back' }))
    })
    expect(nativeTabs.get(secondLabel!)?.visible).toBe(false)
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue('')
    expect(activePanel().getByText('Enter a URL above or ask your agent to open a page.')).toBeInTheDocument()
    expect(calls.filter(({ command }) => command === 'browser_create')).toHaveLength(2)
    expect(calls.filter(({ command }) => command === 'browser_close')).toHaveLength(0)
  })

  it('combines tabs and browser actions without a title, bookmark controls, or domain row', async () => {
    render(<SidebarWebview config={config} />)
    await initialize()
    expect(activePanel().queryByRole('heading', { name: 'First page' })).toBeNull()
    expect(activePanel().queryByRole('button', { name: /bookmark/i })).toBeNull()
    expect(activePanel().queryByText('first.example')).toBeNull()
    expect(
      activePanel().getByRole('button', { name: 'Close browser' }).closest('[data-browser-tab-strip]'),
    ).not.toBeNull()
    expect(activePanel().getByRole('tab', { name: 'First page' }).closest('[data-browser-tab-strip]')).not.toBeNull()
    fireEvent.doubleClick(document.querySelector('[data-browser-tab-empty]')!)
    await initialize()
    expect(nativeTabs.size).toBe(2)
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveFocus()
  })

  it('opens native popup requests in a new tab and releases every closed session', async () => {
    const onClose = mock(() => {})
    render(<SidebarWebview config={config} onClose={onClose} />)
    await initialize()
    const firstLabel = [...nativeTabs.keys()][0]
    await act(async () => {
      await emit('browser-new-tab', { label: 'sidebar-webview-closed', url: popupUrl })
      await emit('browser-new-tab', { label: firstLabel, url: 'javascript:alert(1)' })
    })
    await initialize()
    expect(nativeTabs.size).toBe(1)
    await act(async () => {
      await emit('browser-new-tab', { label: firstLabel, url: popupUrl })
    })
    await initialize()
    expect(nativeTabs.size).toBe(2)
    expect(nativeTabs.get(firstLabel)?.history).toEqual([firstUrl])
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue(popupUrl)
    expect(calls.filter(({ command }) => command === 'browser_navigate')).toHaveLength(0)

    await act(async () => {
      fireEvent.click(activePanel().getByRole('button', { name: 'Close tab Popup page' }))
    })
    expect([...nativeTabs.keys()]).toEqual([firstLabel])
    expect(activePanel().getByRole('textbox', { name: 'Address' })).toHaveValue(firstUrl)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(activePanel().getByRole('button', { name: 'Close tab First page' }))
    })
    expect(nativeTabs.size).toBe(0)
    expect(document.querySelector('[data-browser-tab-panel]')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
