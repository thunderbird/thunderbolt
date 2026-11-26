/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { initializeDocsMenu } from './docs-menu'

const desktop = Object.assign(new EventTarget(), { matches: false })
let restore: () => void
let dispose: () => void
let host: HTMLElement
let button: HTMLButtonElement
let link: HTMLAnchorElement

beforeEach(() => {
  const matchMedia = spyOn(window, 'matchMedia').mockReturnValue(desktop as MediaQueryList)
  restore = () => matchMedia.mockRestore()
  document.body.innerHTML = `
    <a class="sl-skip-link" href="#content">Skip to content</a>
    <nav><starlight-menu-button><button aria-expanded="false">Menu</button></starlight-menu-button>
    <div id="starlight__sidebar"><a href="/docs/using/">Using Thunderbolt</a></div></nav>
    <main class="main-frame" id="content">Content</main>`
  host = document.querySelector('starlight-menu-button')!
  button = host.querySelector('button')!
  link = document.querySelector('#starlight__sidebar a')!
  dispose = initializeDocsMenu(host)
})

afterEach(() => {
  dispose()
  restore()
  document.body.innerHTML = ''
})

test('open and close keep the actual button, sidebar host, body, and focus boundary synchronized', () => {
  for (const expanded of [true, false]) {
    button.click()
    expect(button.getAttribute('aria-expanded')).toBe(String(expanded))
    expect(host.getAttribute('aria-expanded')).toBe(String(expanded))
    expect(document.body.hasAttribute('data-mobile-menu-expanded')).toBe(expanded)
    expect(document.querySelector('.main-frame')!.hasAttribute('inert')).toBe(expanded)
    expect(document.querySelector('.sl-skip-link')!.hasAttribute('inert')).toBe(expanded)
  }
})

test('Escape closes an open sidebar and returns focus, without interfering with other keys or closed menus', () => {
  button.click()
  link.focus()
  link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(button.getAttribute('aria-expanded')).toBe('true')
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  link.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(button)
  expect(button.getAttribute('aria-expanded')).toBe('false')
  link.focus()
  link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.activeElement).toBe(link)
})

test('crossing the desktop breakpoint releases the mobile focus boundary', () => {
  button.click()
  desktop.dispatchEvent(new Event('change'))
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('.main-frame')!.hasAttribute('inert')).toBe(false)
})

test('disconnect closes the menu and removes every listener', () => {
  button.click()
  dispose()
  expect(document.body.hasAttribute('data-mobile-menu-expanded')).toBe(false)
  button.click()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  host.setAttribute('aria-expanded', 'test')
  desktop.dispatchEvent(new Event('change'))
  expect(host.getAttribute('aria-expanded')).toBe('test')
  link.focus()
  link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.activeElement).toBe(link)
})
