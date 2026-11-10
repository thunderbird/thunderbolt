/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'bun:test'
import { Window } from 'happy-dom'

const source = readFileSync(new URL('./favicon-reader.js', import.meta.url), 'utf8')
const windows: Window[] = []
afterEach(() => {
  for (const window of windows.splice(0)) {
    window.happyDOM.abort()
  }
})

it('reads current declared icons relative to base URI, including shortcut icons, before touch icons', () => {
  const window = new Window({ url: 'https://example.com/page' })
  windows.push(window)
  window.document.head.innerHTML =
    '<base href="https://cdn.example.com/assets/"><link rel="apple-touch-icon" href="touch.png"><link rel="shortcut ICON" href="favicon.svg"><link rel="icon" href="favicon.svg">'
  const read = () => window.eval(source) as { url: string; icons: string[] }
  expect(read()).toEqual({
    url: 'https://example.com/page',
    icons: ['https://cdn.example.com/assets/favicon.svg', 'https://cdn.example.com/assets/touch.png'],
  })
  window.document.querySelector('link[rel="shortcut ICON"]')!.setAttribute('href', '/changed.png')
  expect(read().icons[0]).toBe('https://cdn.example.com/changed.png')
})

it('bounds returned icon candidates and does not expose a host bridge', () => {
  const window = new Window({ url: 'https://example.com/' })
  windows.push(window)
  window.document.head.innerHTML = Array.from(
    { length: 30 },
    (_, index) => `<link rel="icon" href="/${index}.png">`,
  ).join('')
  expect((window.eval(source) as { icons: string[] }).icons).toHaveLength(8)
  expect(Reflect.get(window, '__TAURI_INTERNALS__')).toBeUndefined()
})
