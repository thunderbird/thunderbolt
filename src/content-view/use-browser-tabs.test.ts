/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { useBrowserTabs } from './use-browser-tabs'

const initialConfig = { url: 'https://example.com/' }

describe('useBrowserTabs', () => {
  it('reuses a blank tab for repeated sidebar requests while explicit new-tab actions stay independent', () => {
    const { result, rerender } = renderHook(({ config }) => useBrowserTabs(config), {
      initialProps: { config: initialConfig },
    })
    const pageId = result.current.activeId
    rerender({ config: { url: 'about:blank' } })
    const blankId = result.current.activeId
    rerender({ config: { url: 'about:blank' } })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeId).toBe(blankId)
    act(() => result.current.selectTab(pageId))
    rerender({ config: { url: 'about:blank' } })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeId).toBe(blankId)
    act(() => result.current.openTab())
    const explicitBlankId = result.current.activeId
    expect(result.current.tabs).toHaveLength(3)
    rerender({ config: { url: 'about:blank' } })
    expect(result.current.activeId).toBe(explicitBlankId)
    act(() => result.current.closeTab(blankId))
    act(() => result.current.closeTab(explicitBlankId))
    rerender({ config: { url: 'about:blank' } })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.activeId).not.toBe(blankId)
    expect(result.current.activeId).not.toBe(explicitBlankId)
  })

  it('opens and selects independent tabs without changing existing navigation configs', () => {
    const { result } = renderHook(() => useBrowserTabs(initialConfig))
    const first = result.current.tabs[0]
    act(() => result.current.openTab())
    const second = result.current.tabs[1]
    expect(second.config.url).toBe('about:blank')
    expect(second.focusAddress).toBe(true)
    expect(result.current.activeId).toBe(second.id)
    act(() => result.current.selectTab(first.id))
    expect(result.current.activeId).toBe(first.id)
    expect(result.current.tabs[0].config).toBe(first.config)
    act(() => result.current.openTab('https://mozilla.org/'))
    expect(result.current.tabs[2].focusAddress).toBe(false)
    expect(result.current.tabs[2].config.url).toBe('https://mozilla.org/')
    act(() => result.current.openTab('javascript:alert(1)'))
    expect(result.current.tabs).toHaveLength(3)
  })

  it('closes background tabs without changing selection and selects a neighbor for the active tab', () => {
    const { result } = renderHook(() => useBrowserTabs(initialConfig))
    const first = result.current.tabs[0].id
    act(() => result.current.openTab())
    const second = result.current.activeId
    act(() => result.current.openTab())
    const third = result.current.activeId
    act(() => result.current.closeTab(first))
    expect(result.current.activeId).toBe(third)
    act(() => result.current.selectTab(second))
    act(() => result.current.closeTab(second))
    expect(result.current.activeId).toBe(third)
    act(() => result.current.closeTab(third))
    expect(result.current.tabs).toHaveLength(0)
    expect(result.current.activeId).toBe('')
  })

  it('allows agent-created blank tabs to leave the address bar unfocused', () => {
    const { result } = renderHook(() => useBrowserTabs(initialConfig))
    act(() => result.current.openTab(undefined, { focusAddress: false }))
    expect(result.current.tabs.at(-1)).toMatchObject({ url: 'about:blank', focusAddress: false })
    act(() => result.current.openTab())
    expect(result.current.tabs.at(-1)).toMatchObject({ url: 'about:blank', focusAddress: true })
  })

  it('cycles through open tabs with wraparound and ignores closed ids', () => {
    const { result } = renderHook(() => useBrowserTabs(initialConfig))
    const first = result.current.activeId
    act(() => result.current.openTab())
    const second = result.current.activeId
    act(() => result.current.cycleTab(1))
    expect(result.current.activeId).toBe(first)
    act(() => result.current.cycleTab(-1))
    expect(result.current.activeId).toBe(second)
    act(() => result.current.closeTab(second))
    act(() => result.current.selectTab(second))
    act(() => result.current.cycleTab(1))
    expect(result.current.activeId).toBe(first)
  })

  it('updates page metadata without changing tab identity or reopening a closed tab', () => {
    const { result } = renderHook(() => useBrowserTabs(initialConfig))
    const first = result.current.tabs[0]
    const page = {
      url: 'https://example.com/redirected',
      title: 'Redirect destination',
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    }
    act(() => result.current.updateTab(first.id, page))
    expect(result.current.tabs[0]).toMatchObject({ id: first.id, title: page.title, url: page.url })
    expect(result.current.tabs[0].config).toBe(first.config)
    act(() => result.current.closeTab(first.id))
    act(() => result.current.updateTab(first.id, page))
    expect(result.current.tabs).toHaveLength(0)
  })

  it('updates dynamic favicons even when URL and title stay the same, then clears them after navigation', () => {
    const { result } = renderHook(() => useBrowserTabs(initialConfig))
    const tab = result.current.tabs[0]
    const page = { url: tab.url, title: 'Example', isLoading: false, canGoBack: false, canGoForward: false }
    act(() => result.current.updateTab(tab.id, { ...page, faviconUrls: ['https://example.com/first.png'] }))
    act(() => result.current.updateTab(tab.id, { ...page, faviconUrls: ['https://example.com/second.svg'] }))
    expect(result.current.tabs[0].faviconUrls).toEqual(['https://example.com/second.svg'])
    act(() => result.current.updateTab(tab.id, { ...page, url: 'https://other.example/', faviconUrls: [] }))
    expect(result.current.tabs[0].faviconUrls).toEqual([])
  })

  it('opens a new chat link once while retaining the other tabs', () => {
    const { result, rerender } = renderHook(({ config }) => useBrowserTabs(config), {
      initialProps: { config: initialConfig },
    })
    const first = result.current.tabs[0]
    const link = { url: 'https://mozilla.org/' }
    rerender({ config: link })
    expect(result.current.tabs).toHaveLength(2)
    expect(result.current.tabs[0]).toBe(first)
    rerender({ config: link })
    expect(result.current.tabs).toHaveLength(2)
    // Opening the same chat link again is still an explicit new browsing request.
    rerender({ config: { ...link } })
    expect(result.current.tabs).toHaveLength(3)
    act(() => result.current.closeAll())
    expect(result.current.tabs).toHaveLength(0)
  })
})
