/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useKeyboardInset } from './use-keyboard-inset'

/**
 * Stands in for `window.visualViewport`, exposing the listeners it was given so
 * a test can fire the keyboard (`resize`) and pan (`scroll`) events the real
 * API delivers. Assigning to `window` is how the hook reaches it.
 */
const installVisualViewport = (height: number, offsetTop = 0) => {
  const listeners = new Map<string, Set<EventListener>>()
  const viewport = {
    height,
    offsetTop,
    addEventListener: (type: string, listener: EventListener) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener)
    },
  }
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true, writable: true })
  return {
    viewport,
    emit: (type: string) => listeners.get(type)?.forEach((listener) => listener(new Event(type))),
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

const inset = () => document.documentElement.style.getPropertyValue('--kb')
const isInstant = () => document.documentElement.hasAttribute('data-kb-instant')

describe('useKeyboardInset', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--kb')
    document.documentElement.removeAttribute('data-kb-instant')
    Reflect.deleteProperty(window, 'visualViewport')
  })

  it('writes the resting inset without easing it', () => {
    window.innerHeight = 800
    installVisualViewport(800)

    renderHook(() => useKeyboardInset())

    expect(inset()).toBe('0px')
    expect(isInstant()).toBe(true)
  })

  it('eases the inset when the keyboard resizes the viewport', () => {
    window.innerHeight = 800
    const { viewport, emit } = installVisualViewport(800)

    renderHook(() => useKeyboardInset())
    viewport.height = 464
    emit('resize')

    expect(inset()).toBe('336px')
    expect(isInstant()).toBe(false)
  })

  it('applies a pan instantly so the inset cannot trail the finger', () => {
    window.innerHeight = 800
    const { viewport, emit } = installVisualViewport(800)

    renderHook(() => useKeyboardInset())
    viewport.height = 464
    emit('resize')
    viewport.offsetTop = 40
    emit('scroll')

    expect(inset()).toBe('296px')
    expect(isInstant()).toBe(true)
  })

  it('never reports a negative inset', () => {
    window.innerHeight = 800
    const { viewport, emit } = installVisualViewport(800)

    renderHook(() => useKeyboardInset())
    viewport.height = 900
    emit('resize')

    expect(inset()).toBe('0px')
  })

  it('detaches both listeners on unmount', () => {
    window.innerHeight = 800
    const { listenerCount } = installVisualViewport(800)

    const { unmount } = renderHook(() => useKeyboardInset())
    expect(listenerCount('resize')).toBe(1)
    expect(listenerCount('scroll')).toBe(1)

    unmount()

    expect(listenerCount('resize')).toBe(0)
    expect(listenerCount('scroll')).toBe(0)
  })

  it('is a no-op where the Visual Viewport API is missing', () => {
    Reflect.deleteProperty(window, 'visualViewport')

    renderHook(() => useKeyboardInset())

    expect(inset()).toBe('')
  })
})
