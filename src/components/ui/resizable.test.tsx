/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './resizable'

afterEach(() => {
  cleanup()
  mock.restore()
})

describe('ResizableHandle', () => {
  it('is named and seeds its value range from the leading panel share', () => {
    // No layout engine in the test DOM: report a 100px group with a 40px leading panel.
    spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width =
        this.dataset.slot === 'resizable-panel-group' ? 100 : this.dataset.slot === 'resizable-panel' ? 40 : 0
      return { width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) }
    })
    render(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="a" defaultSize={50} />
        <ResizableHandle />
        <ResizablePanel id="b" defaultSize={50} />
      </ResizablePanelGroup>,
    )
    const handle = screen.getByRole('separator', { name: 'Resize panels' })
    expect(handle.getAttribute('aria-valuemin')).toBe('0')
    expect(handle.getAttribute('aria-valuemax')).toBe('100')
    expect(handle.getAttribute('aria-valuenow')).toBe('40')
  })
})
