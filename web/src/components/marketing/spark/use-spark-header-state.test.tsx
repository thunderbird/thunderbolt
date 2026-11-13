/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSparkHeaderState } from './use-spark-header-state'

const HeaderHarness = () => {
  const { isOpen, toggleNavigation, closeNavigation, onNavigationBlur, navigationRef, triggerRef } =
    useSparkHeaderState()
  return (
    <>
      <div ref={navigationRef} onBlur={onNavigationBlur}>
        <button ref={triggerRef} onClick={toggleNavigation} aria-expanded={isOpen}>
          Explore
        </button>
        <div hidden={!isOpen}>
          <a href="#docs" onClick={closeNavigation}>
            Docs
          </a>
          <a href="#blog">Blog</a>
        </div>
      </div>
      <button data-outside>Outside</button>
    </>
  )
}

let container: HTMLDivElement
let root: Root
let trigger: HTMLButtonElement
let outside: HTMLButtonElement

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<HeaderHarness />))
  trigger = container.querySelector('button')!
  outside = container.querySelector('[data-outside]')!
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

test('toggle and a selected page close the disclosure', () => {
  act(() => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => trigger.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  act(() => trigger.click())
  act(() => container.querySelector('a')!.click())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('inside clicks stay open, outside pointer dismisses without stealing focus', () => {
  act(() => trigger.click())
  act(() => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).not.toBe(trigger)
})

test('keyboard focus can move within the panel; leaving it closes the disclosure', () => {
  act(() => trigger.click())
  act(() => trigger.focus())
  act(() => container.querySelector('a')!.focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => outside.focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('Escape dismisses and restores the trigger; other keys and closed-menu Escape do not', () => {
  act(() => trigger.click())
  act(() => container.querySelector('a')!.focus())
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })))
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  act(() => outside.focus())
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.activeElement).toBe(outside)
})

test('unmount removes document listeners instead of refocusing a detached trigger', () => {
  act(() => trigger.click())
  act(() => root.unmount())
  document.body.focus()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.activeElement).not.toBe(trigger)
})
