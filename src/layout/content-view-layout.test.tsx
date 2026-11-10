/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppContentOverlayProvider } from '@/components/app-content-overlay'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import * as platform from '@/lib/platform'
import { usePageStore } from '@/pages/page-store'
import { createTestProvider } from '@/test-utils/test-provider'
import { animateSpy, registerFramerMotionMock } from '@/test-utils/framer-motion-mock'
import { getClock } from '@/testing-library'
import * as tauriCore from '@tauri-apps/api/core'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Link, MemoryRouter, Outlet, Route, Routes } from 'react-router'

registerFramerMotionMock()
const { ContentViewLayout } = await import('./content-view-layout')
const originalAnimate = animateSpy.getMockImplementation()!

const nativeTabs = new Map<string, string>()
const created: string[] = []
let tauriSpy: ReturnType<typeof spyOn<typeof platform, 'isTauri'>>
let platformSpy: ReturnType<typeof spyOn<typeof platform, 'isTauriDesktop'>>
let invokeSpy: ReturnType<typeof spyOn<typeof tauriCore, 'invoke'>>
let boundsSpy: ReturnType<typeof spyOn<HTMLElement, 'getBoundingClientRect'>>

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(() => {
  animateSpy.mockImplementation((value, target, options) => {
    if (typeof value !== 'number') {
      return originalAnimate(value, target, options)
    }
    const animation = options as { onUpdate: (width: number) => void; onComplete: () => void }
    animation.onUpdate(Number(target))
    animation.onComplete()
    return Object.assign(Promise.resolve(), { stop: () => undefined })
  })
  usePageStore.setState({ sessions: [], activeId: null })
  nativeTabs.clear()
  created.length = 0
  platformSpy = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  tauriSpy = spyOn(platform, 'isTauri').mockReturnValue(true)
  boundsSpy = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 150, 500, 600))
  mockWindows('main')
  mockIPC(
    (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>
      const label = args.label as string
      switch (command) {
        case 'plugin:webview|webview_position':
          return { x: 0, y: 0 }
        case 'plugin:window|scale_factor':
          return 1
        case 'browser_create':
          nativeTabs.set(label, args.url as string)
          created.push(label)
          return
        case 'browser_get_state':
          return { url: nativeTabs.get(label), title: '', isLoading: false, canGoBack: false, canGoForward: false }
        case 'browser_close':
          nativeTabs.delete(label)
          return
        case 'plugin:webview|get_all_webviews':
          return [...nativeTabs.keys()].map((label) => ({ label, windowLabel: 'main' }))
      }
    },
    { shouldMockEvents: true },
  )
  const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: typeof tauriCore.invoke }
  invokeSpy = spyOn(tauriCore, 'invoke').mockImplementation(internals.invoke)
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  platformSpy.mockRestore()
  tauriSpy.mockRestore()
  invokeSpy.mockRestore()
  boundsSpy.mockRestore()
  animateSpy.mockImplementation(originalAnimate)
  clearMocks()
})

const SharedShell = () => {
  const { showPreview } = useContentView()
  return (
    <>
      <nav>
        <Link to="/chats/new">Chat route</Link>
        <Link to="/settings/preferences">Settings route</Link>
        <button onClick={() => showPreview('about:blank')}>Open browser</button>
      </nav>
      <ContentViewLayout>
        <Outlet />
      </ContentViewLayout>
    </>
  )
}

const renderAt = (path: string) => {
  const Provider = createTestProvider()
  return render(
    <Provider>
      <ContentViewProvider>
        <AppContentOverlayProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<SharedShell />}>
                <Route path="chats/new" element={<h1>Conversation</h1>} />
                <Route path="settings/preferences" element={<h1>Preferences</h1>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AppContentOverlayProvider>
      </ContentViewProvider>
    </Provider>,
  )
}

/** Let native view creation and route layout effects finish without draining the poll loop. */
const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(30)
  })
}

describe('ContentViewLayout', () => {
  it('releases the sidebar when its last page is closed outside the toolbar', async () => {
    renderAt('/chats/new')
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    await settle()
    expect(document.querySelector('[data-slot="resizable-handle"]')).toBeInTheDocument()
    act(() => usePageStore.getState().close(usePageStore.getState().activeId!))
    await settle()
    expect(document.querySelector('[data-page-panel]')).toBeNull()
    expect(document.querySelector('[data-slot="resizable-handle"]')).toBeNull()
    expect(document.querySelector('[data-slot="app-content-overlay-host"]')).toBeNull()
  })

  it('opens the browser from settings and keeps the same native tabs across route changes', async () => {
    renderAt('/settings/preferences')
    fireEvent.click(screen.getByRole('button', { name: 'Open browser' }))
    await settle()
    const firstPanel = document.querySelector<HTMLElement>('[data-browser-tab-panel]')!
    expect(firstPanel).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument()
    const overlayHost = document.querySelector<HTMLElement>('[data-slot="app-content-overlay-host"]')!
    expect(overlayHost).toHaveClass('-right-6')
    const panel = overlayHost.closest('[data-panel]')!
    expect(panel.firstElementChild).toHaveStyle({ overflow: 'visible' })
    fireEvent.click(within(firstPanel).getByRole('button', { name: 'New tab' }))
    await settle()
    const nativeLabels = [...nativeTabs.keys()]
    expect(nativeLabels).toHaveLength(2)
    const secondPanel = document.querySelector<HTMLElement>('[data-browser-tab-panel]:not([inert])')!
    const address = within(secondPanel).getByRole('textbox', { name: 'Address' })
    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'unfinished.example' } })

    fireEvent.click(screen.getByRole('link', { name: 'Chat route' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeInTheDocument()
    expect(firstPanel).toBeInTheDocument()
    expect(secondPanel).toBeInTheDocument()
    expect(address).toHaveValue('unfinished.example')
    expect([...nativeTabs.keys()]).toEqual(nativeLabels)
    expect(created).toHaveLength(2)

    fireEvent.click(screen.getByRole('link', { name: 'Settings route' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Preferences' })).toBeInTheDocument()
    expect([...nativeTabs.keys()]).toEqual(nativeLabels)
    expect(created).toHaveLength(2)
  })
})
