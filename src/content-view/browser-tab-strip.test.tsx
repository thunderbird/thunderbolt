/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import { BrowserTabStrip } from './browser-tab-strip'
import type { BrowserTab } from './use-browser-tabs'

const tabs: BrowserTab[] = ['First page', 'Second page'].map((title, index) => ({
  id: `tab-${index}`,
  config: { url: `https://example.com/${index}` },
  url: `https://example.com/${index}`,
  title,
  isLoading: false,
  focusAddress: false,
  closedAt: null,
}))

/** Render a strip with observable user actions. */
const renderStrip = () => {
  const props = {
    tabs,
    activeId: tabs[0].id,
    visible: false,
    onSelect: mock((_id: string) => {}),
    onClose: mock((_id: string) => {}),
    onNewTab: mock(() => {}),
  }
  return { ...render(<BrowserTabStrip {...props} />), props }
}

describe('BrowserTabStrip', () => {
  it('exposes tab selection and separate create/close controls', () => {
    const { getByRole, props } = renderStrip()
    expect(getByRole('tab', { name: 'First page' })).toHaveAttribute('aria-selected', 'true')
    expect(getByRole('tab', { name: 'Second page' })).toHaveAttribute('tabindex', '-1')
    fireEvent.click(getByRole('tab', { name: 'Second page' }))
    expect(props.onSelect).toHaveBeenCalledWith(tabs[1].id)
    fireEvent.click(getByRole('button', { name: 'Close tab Second page' }))
    expect(props.onClose).toHaveBeenCalledWith(tabs[1].id)
    fireEvent.click(getByRole('button', { name: 'New tab' }))
    expect(props.onNewTab).toHaveBeenCalledTimes(1)
  })

  it('supports arrow, home/end, and delete keys without intercepting keys on close buttons', () => {
    const { getByRole, props } = renderStrip()
    const first = getByRole('tab', { name: 'First page' })
    for (const key of ['ArrowRight', 'ArrowLeft', 'End']) {
      fireEvent.keyDown(first, { key })
      expect(props.onSelect).toHaveBeenLastCalledWith(tabs[1].id)
    }
    fireEvent.keyDown(first, { key: 'Home' })
    expect(props.onSelect).toHaveBeenLastCalledWith(tabs[0].id)
    fireEvent.keyDown(first, { key: 'Delete' })
    expect(props.onClose).toHaveBeenCalledWith(tabs[0].id)
    props.onSelect.mockClear()
    fireEvent.keyDown(getByRole('button', { name: 'Close tab First page' }), { key: 'ArrowRight' })
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('opens a tab on double-click in the empty strip without intercepting tab or button double-clicks', () => {
    const { container, getByRole, props } = renderStrip()
    fireEvent.doubleClick(container.querySelector('[data-browser-tab-empty]')!)
    expect(props.onNewTab).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(getByRole('tab', { name: 'First page' }))
    fireEvent.doubleClick(getByRole('button', { name: 'Close tab First page' }))
    fireEvent.doubleClick(getByRole('button', { name: 'New tab' }))
    expect(props.onNewTab).toHaveBeenCalledTimes(1)
  })
})
