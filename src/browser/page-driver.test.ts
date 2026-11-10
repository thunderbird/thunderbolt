/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Window, type Element as PageElement } from 'happy-dom'
import type { PageAction, PageSnapshot } from '@shared/page-protocol'
import type { BrowserElementSelection } from '@/content-view/browser-element-reference'

const source = readFileSync(new URL('./page-driver.js', import.meta.url), 'utf8')
type Driver = {
  snapshot: () => Omit<PageSnapshot, 'pageId' | 'sessionId' | 'capabilities'>
  prepare: (action: PageAction) => { x: number; y: number }
  cursor: (x: number, y: number, click?: boolean) => void
  setPicker: (enabled: boolean, requestId: string) => boolean
  takePick: (requestId: string) => (BrowserElementSelection & { requestId: string }) | { cancelled: true } | null
}
const windows: Window[] = []

/** Evaluate the exact native-included script in a separate page realm, with explicit layout geometry. */
const page = (html = '<button id="next">Continue</button>', url = 'https://example.com/') => {
  const window = new Window({ url, width: 800, height: 600 })
  windows.push(window)
  window.document.title = 'Fixture'
  window.document.body.innerHTML = html
  const show = (element: PageElement, x = 20, y = 30, width = 120, height = 40) => {
    element.getBoundingClientRect = () => new window.DOMRect(x, y, width, height)
    element.scrollIntoView = mock(() => {})
    return element
  }
  for (const element of window.document.querySelectorAll('*')) {
    show(element)
  }
  window.document.elementFromPoint = () => window.document.querySelector('button,input,a')
  const install = (): Driver => {
    window.eval(source)
    return Reflect.get(window, '__thunderboltBrowserDriver') as Driver
  }
  return { window, show, install, driver: install() }
}

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()))
})

describe('native browser page driver', () => {
  it('reuses the driver and stable element refs across repeated native evaluations', () => {
    const { driver, install, window } = page()
    const first = driver.snapshot()
    expect(first.elements[0].name).toBe('Continue')
    expect(first.elements[0].ref).toStartWith(`${first.documentId}:`)
    expect(install()).toBe(driver)
    expect(driver.snapshot().elements[0].ref).toBe(first.elements[0].ref)
    driver.cursor(20, 30)
    driver.cursor(40, 50, true)
    expect(window.document.querySelectorAll('[data-thunderbolt-browser-overlay]')).toHaveLength(1)
  })

  it('rejects detached and previous-document refs rather than retargeting their replacement', () => {
    const first = page()
    const original = first.driver.snapshot().elements[0]
    first.window.document.querySelector('button')!.remove()
    expect(() => first.driver.prepare({ type: 'click', ref: original.ref })).toThrow('Stale element reference')
    first.window.document.body.innerHTML = '<button>Replacement</button>'
    first.show(first.window.document.querySelector('button')!)
    expect(first.driver.snapshot().elements[0].ref).not.toBe(original.ref)
    const navigated = page('<button>Continue</button>')
    expect(navigated.driver.snapshot().documentId).not.toBe(first.driver.snapshot().documentId)
    expect(() => navigated.driver.prepare({ type: 'click', ref: original.ref })).toThrow('Stale element reference')
  })

  it('initializes on plain HTTP even when the secure-context randomUUID API is absent', () => {
    const window = new Window({ url: 'http://insecure.example/' })
    windows.push(window)
    const originalRandomUUID = crypto.randomUUID
    // Happy DOM windows share the underlying Crypto object. Replace this window's property
    // instead of deleting a method on the shared instance and poisoning later test files.
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      value: { getRandomValues: window.crypto.getRandomValues.bind(window.crypto) },
    })
    window.eval(source)
    const driver = Reflect.get(window, '__thunderboltBrowserDriver') as Driver
    expect(driver.snapshot().documentId).toMatch(/^[a-f0-9]{32}$/)
    expect(crypto.randomUUID).toBe(originalRandomUUID)
    expect(crypto.randomUUID()).toBeString()
  })

  it('restores a live ref when a framework reattaches the same node after a snapshot pruned it', () => {
    const { driver, window } = page()
    const button = window.document.querySelector('button')!
    const ref = driver.snapshot().elements[0].ref
    button.remove()
    expect(driver.snapshot().elements).toHaveLength(0)
    window.document.body.append(button)
    expect(driver.snapshot().elements[0].ref).toBe(ref)
    expect(driver.prepare({ type: 'click', ref })).toEqual({ x: 80, y: 50 })
  })

  it('bounds snapshots and omits password values, hidden fields, and offscreen elements', () => {
    const { driver, window, show } = page(`
      <label for="secret">Password</label><input id="secret" type="password" value="private-secret">
      <input aria-label="Name" value="Taylor"><input type="hidden" value="private-hidden">
      <button id="offscreen">Offscreen</button><button style="display:none">Hidden</button>
      <p>${'Long page '.repeat(4_000)}</p>`)
    show(window.document.getElementById('offscreen')!, 900, 30)
    window.document.title = 'Long title '.repeat(200)
    const snapshot = driver.snapshot()
    expect(snapshot.text.length).toBeLessThanOrEqual(24_000)
    expect(snapshot.title.length).toBeLessThanOrEqual(500)
    expect(snapshot.elements.map((element) => element.name)).toEqual(['Password', 'Name'])
    expect(snapshot.elements[0]).not.toHaveProperty('value')
    expect(snapshot.elements[1].value).toBe('Taylor')
    expect(JSON.stringify(snapshot)).not.toContain('private-secret')
    expect(JSON.stringify(snapshot)).not.toContain('private-hidden')
  })

  it('captures open-shadow DOM controls and their accessible names', () => {
    const { driver, window, show } = page('<div id="host"></div>')
    const host = window.document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<span id="button-label">Shadow action</span><button aria-labelledby="button-label"></button>'
    show(shadow.querySelector('button')!)
    const snapshot = driver.snapshot()
    expect(snapshot.elements).toHaveLength(1)
    expect(snapshot.elements[0].name).toBe('Shadow action')
    window.document.elementFromPoint = () => host
    Object.defineProperty(shadow, 'elementFromPoint', { value: () => shadow.querySelector('button') })
    expect(driver.prepare({ type: 'click', ref: snapshot.elements[0].ref })).toEqual({ x: 80, y: 50 })
  })

  it('intercepts a picked link without activating it and returns the same actionable ref once', () => {
    const { driver, window } = page('<a id="next" href="/next">Next page</a>')
    const reference = driver.snapshot().elements[0].ref
    const clicked = mock(() => {})
    const link = window.document.getElementById('next')!
    link.addEventListener('click', clicked)
    driver.setPicker(true, 'gesture-one')
    expect(driver.takePick('gesture-one')).toBeNull()
    const click = new window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
    expect(driver.takePick('gesture-one')).toMatchObject({
      requestId: 'gesture-one',
      url: 'https://example.com/',
      element: { id: reference, label: 'Next page', data: { href: 'https://example.com/next' } },
    })
    expect(driver.takePick('gesture-one')).toEqual({ cancelled: true })
  })

  it('cancels on Escape and after navigation, while an old cancellation cannot stop a newer gesture', () => {
    const { driver, window } = page()
    driver.setPicker(true, 'old')
    driver.setPicker(true, 'new')
    driver.setPicker(false, 'old')
    expect(driver.takePick('old')).toEqual({ cancelled: true })
    expect(driver.takePick('new')).toBeNull()
    expect(() => driver.prepare({ type: 'click', x: 10, y: 10 })).toThrow('Finish or cancel element selection')
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(driver.takePick('new')).toMatchObject({ cancelled: true })
    expect(driver.prepare({ type: 'click', x: 10, y: 10 })).toEqual({ x: 10, y: 10 })
    expect(page().driver.takePick('new')).toEqual({ cancelled: true })
  })

  it('rejects invalid viewport coordinates, obscured targets, and unavailable controls', () => {
    const { driver, window, show } = page('<button id="next">Continue</button><div id="cover"></div>')
    const ref = driver.snapshot().elements[0].ref
    for (const point of [
      { x: -1, y: 0 },
      { x: 800, y: 0 },
      { x: 0, y: 600 },
      { x: NaN, y: 0 },
    ]) {
      expect(() => driver.prepare({ type: 'click', ...point })).toThrow('Coordinates must be inside')
    }
    window.document.elementFromPoint = () => window.document.getElementById('cover')
    expect(() => driver.prepare({ type: 'click', ref })).toThrow('covered by another element')
    const button = window.document.getElementById('next')!
    button.setAttribute('disabled', '')
    expect(() => driver.prepare({ type: 'click', ref })).toThrow('Element is disabled')
    button.removeAttribute('disabled')
    button.setAttribute('aria-disabled', 'true')
    expect(() => driver.prepare({ type: 'click', ref })).toThrow('Element is disabled')
    button.removeAttribute('aria-disabled')
    show(button, 900, 50)
    expect(() => driver.prepare({ type: 'click', ref })).toThrow('Element is not visible')
  })

  it('focuses editable targets and refuses typing into readonly or noneditable controls', () => {
    const { driver, window } = page(
      '<input aria-label="Name"><textarea aria-label="Note"></textarea><button>Save</button>',
    )
    const snapshot = driver.snapshot()
    const input = window.document.querySelector('input')!
    driver.prepare({ type: 'type', ref: snapshot.elements[0].ref, text: 'Taylor' })
    expect(window.document.activeElement).toBe(input)
    input.readOnly = true
    expect(() => driver.prepare({ type: 'type', text: 'Taylor' })).toThrow('Element is not editable')
    expect(() => driver.prepare({ type: 'type', ref: snapshot.elements[2].ref, text: 'Taylor' })).toThrow(
      'Focus an editable',
    )
  })

  it('preserves native focus inside a frame for unreferenced typing without making the frame editable', () => {
    const { driver, window } = page('<iframe title="Embedded form"></iframe>')
    const frame = window.document.querySelector('iframe')!
    frame.focus()
    expect(window.document.activeElement).toBe(frame)
    const ref = driver.snapshot().elements[0].ref
    const focus = mock(() => {})
    frame.focus = focus
    expect(driver.prepare({ type: 'type', text: 'Text for the focused frame field' })).toEqual({ x: 80, y: 50 })
    expect(focus).not.toHaveBeenCalled()
    expect(() => driver.prepare({ type: 'type', ref, text: 'Targeting the iframe itself' })).toThrow(
      'Focus an editable element before typing',
    )
    expect(focus).not.toHaveBeenCalled()
  })

  it('types into the focused field inside nested open shadow roots', () => {
    const { driver, window, show } = page('<div id="host"></div>')
    const host = window.document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    const innerHost = window.document.createElement('div')
    shadow.append(innerHost)
    const inner = innerHost.attachShadow({ mode: 'open' })
    const input = window.document.createElement('input')
    inner.append(input)
    show(input)
    input.focus()
    expect(driver.prepare({ type: 'type', text: 'Inside shadow' })).toEqual({ x: 80, y: 50 })
    expect(inner.activeElement).toBe(input)
  })

  it.each(['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit'])(
    'refuses typing into a %s input',
    (type) => {
      const { driver } = page(`<input type="${type}">`)
      const ref = driver.snapshot().elements[0].ref
      expect(() => driver.prepare({ type: 'type', ref, text: 'Unexpected text' })).toThrow('Focus an editable')
    },
  )

  it('rejects referenced targets excluded from hit testing', () => {
    const { driver, window } = page('<button>Click</button>')
    const ref = driver.snapshot().elements[0].ref
    window.document.elementFromPoint = () => null
    expect(() => driver.prepare({ type: 'click', ref })).toThrow('covered')
  })

  it('caps element output on large documents', () => {
    const { driver } = page('<button>Item</button>'.repeat(300))
    expect(driver.snapshot().elements).toHaveLength(250)
  })

  it('installs no remote IPC, generic evaluator, or native credentials in the page', () => {
    const { driver, window } = page()
    expect(Object.keys(driver).sort()).toEqual(['cursor', 'prepare', 'setPicker', 'snapshot', 'takePick'])
    expect(Reflect.get(window, '__TAURI__')).toBeUndefined()
    expect(Reflect.get(window, '__TAURI_INTERNALS__')).toBeUndefined()
    expect(source).not.toMatch(/(?:api[_-]?key|authorization|Bearer |invoke\()/i)
  })
})
