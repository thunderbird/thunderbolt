/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as tauriWindow from '@tauri-apps/api/window'
import * as platformModule from '@/lib/platform'
import { edgeCursorAt, edgeDirectionAt, edgeResizeZone, edgeResizeZoneCoarse, isInteractiveTarget, resizeDirectionFromPointerEvent, resolveEdgeResizeZone, startLinuxEdgeResize } from './edge-resize'

const width = 1400
const height = 900

describe('edgeDirectionAt', () => {
  it('returns null for presses away from every edge', () => {
    expect(edgeDirectionAt(400, 300, width, height)).toBeNull()
    expect(edgeDirectionAt(700, 450, width, height)).toBeNull()
  })

  it('classifies the four edges', () => {
    expect(edgeDirectionAt(2, 300, width, height)).toBe('West')
    expect(edgeDirectionAt(width - 3, 300, width, height)).toBe('East')
    expect(edgeDirectionAt(400, 2, width, height)).toBe('North')
    expect(edgeDirectionAt(400, height - 3, width, height)).toBe('South')
  })

  it('classifies the four corners (corners win over single edges)', () => {
    expect(edgeDirectionAt(2, 2, width, height)).toBe('NorthWest')
    expect(edgeDirectionAt(width - 3, 2, width, height)).toBe('NorthEast')
    expect(edgeDirectionAt(2, height - 3, width, height)).toBe('SouthWest')
    expect(edgeDirectionAt(width - 3, height - 3, width, height)).toBe('SouthEast')
  })

  it('treats the band as exclusive: x < zone on the west, x >= width - zone on the east', () => {
    expect(edgeDirectionAt(3, 400, width, height)).toBe('West')
    expect(edgeDirectionAt(6, 400, width, height)).toBeNull()
    expect(edgeDirectionAt(width - 6, 400, width, height)).toBe('East')
    expect(edgeDirectionAt(width - 7, 400, width, height)).toBeNull()
  })

  it('honours a custom zone', () => {
    expect(edgeDirectionAt(10, 400, width, height, 12)).toBe('West')
    expect(edgeDirectionAt(12, 400, width, height, 12)).toBeNull()
  })
})

describe('resizeDirectionFromPointerEvent', () => {
  let originalInnerWidth: number
  let originalInnerHeight: number

  beforeEach(() => {
    originalInnerWidth = window.innerWidth
    originalInnerHeight = window.innerHeight
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('maps clientX/clientY to a direction via the viewport size', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    const edge = new PointerEvent('pointerdown', { clientX: width - 3, clientY: 300 })
    const interior = new PointerEvent('pointerdown', { clientX: 400, clientY: 300 })
    expect(resizeDirectionFromPointerEvent(edge)).toBe('East')
    expect(resizeDirectionFromPointerEvent(interior)).toBeNull()
  })
})

describe('isInteractiveTarget', () => {
  it('skips nothing for non-element targets', () => {
    expect(isInteractiveTarget(null)).toBe(false)
  })

  it('detects interactive controls and their descendants', () => {
    const button = document.createElement('button')
    const span = document.createElement('span')
    button.appendChild(span)
    document.body.appendChild(button)
    expect(isInteractiveTarget(button)).toBe(true)
    expect(isInteractiveTarget(span)).toBe(true)
    document.body.removeChild(button)
  })

  it('allows plain containers', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(isInteractiveTarget(div)).toBe(false)
    document.body.removeChild(div)
  })
})

describe('startLinuxEdgeResize', () => {
  let originalInnerWidth: number
  let originalInnerHeight: number

  beforeEach(() => {
    originalInnerWidth = window.innerWidth
    originalInnerHeight = window.innerHeight
    document.addEventListener('pointerdown', startLinuxEdgeResize)
  })

  afterEach(() => {
    document.removeEventListener('pointerdown', startLinuxEdgeResize)
    mock.restore()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
  })

  it('starts a native resize drag for an edge press with the exact direction', () => {
    spyOn(platformModule, 'isTauri').mockImplementation(() => true)
    spyOn(platformModule, 'getPlatform').mockImplementation(() => 'linux' as never)
    const startResizeDragging = mock()
    spyOn(tauriWindow, 'getCurrentWindow').mockImplementation(() => ({ startResizeDragging }) as never)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const div = document.createElement('div')
    document.body.appendChild(div)
    const event = new PointerEvent('pointerdown', { clientX: 1397, clientY: 300, bubbles: true, cancelable: true })
    div.dispatchEvent(event)

    expect(startResizeDragging).toHaveBeenCalledTimes(1)
    expect(startResizeDragging).toHaveBeenCalledWith('East')
    expect(event.defaultPrevented).toBe(true)
    document.body.removeChild(div)
  })

  it('does nothing on non-Linux platforms', () => {
    spyOn(platformModule, 'isTauri').mockImplementation(() => true)
    spyOn(platformModule, 'getPlatform').mockImplementation(() => 'windows' as never)
    const startResizeDragging = mock()
    spyOn(tauriWindow, 'getCurrentWindow').mockImplementation(() => ({ startResizeDragging }) as never)

    const event = new PointerEvent('pointerdown', { clientX: 1397, clientY: 300, cancelable: true })
    document.dispatchEvent(event)

    expect(startResizeDragging).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does nothing when the press lands on an interactive control', () => {
    spyOn(platformModule, 'isTauri').mockImplementation(() => true)
    spyOn(platformModule, 'getPlatform').mockImplementation(() => 'linux' as never)
    const startResizeDragging = mock()
    spyOn(tauriWindow, 'getCurrentWindow').mockImplementation(() => ({ startResizeDragging }) as never)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const button = document.createElement('button')
    document.body.appendChild(button)
    const event = new PointerEvent('pointerdown', { clientX: 1397, clientY: 300, bubbles: true, cancelable: true })
    button.dispatchEvent(event)

    expect(startResizeDragging).not.toHaveBeenCalled()
    document.body.removeChild(button)
  })
})

describe('edgeCursorAt', () => {
  const w = 800
  const h = 600

  it('gives each edge the cursor the platform uses for it', () => {
    expect(edgeCursorAt(2, h / 2, w, h, 6)).toBe('ew-resize')
    expect(edgeCursorAt(w - 2, h / 2, w, h, 6)).toBe('ew-resize')
    expect(edgeCursorAt(w / 2, 2, w, h, 6)).toBe('ns-resize')
    expect(edgeCursorAt(w / 2, h - 2, w, h, 6)).toBe('ns-resize')
  })

  it('gives opposite corners the same diagonal, as a window frame does', () => {
    expect(edgeCursorAt(2, 2, w, h, 6)).toBe('nwse-resize')
    expect(edgeCursorAt(w - 2, h - 2, w, h, 6)).toBe('nwse-resize')
    expect(edgeCursorAt(w - 2, 2, w, h, 6)).toBe('nesw-resize')
    expect(edgeCursorAt(2, h - 2, w, h, 6)).toBe('nesw-resize')
  })

  it('is null in the interior, so the app keeps its own cursor', () => {
    expect(edgeCursorAt(w / 2, h / 2, w, h, 6)).toBeNull()
    expect(edgeCursorAt(6, 6, w, h, 6)).toBeNull()
  })
})

describe('resolveEdgeResizeZone', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it('widens the band for a coarse pointer — a finger cannot hit 6px', () => {
    window.matchMedia = ((query: string) => ({ matches: query === '(pointer: coarse)' })) as typeof window.matchMedia
    expect(resolveEdgeResizeZone()).toBe(edgeResizeZoneCoarse)
    expect(edgeResizeZoneCoarse).toBeGreaterThan(edgeResizeZone)
  })

  it('keeps the fine band for a mouse', () => {
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    expect(resolveEdgeResizeZone()).toBe(edgeResizeZone)
  })
})
