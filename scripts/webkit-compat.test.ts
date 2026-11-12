/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import { addWebKitCompatToAsset, webkitCompatScript } from './webkit-compat'

const navigator = { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15' }

it('runs as a classic bootstrap before dependency code captures an intrinsic', () => {
  const context = createContext({ navigator })
  runInContext(webkitCompatScript + 'const captured = Object.prototype.hasOwnProperty;', context)
  expect(
    runInContext(
      `Object.getOwnPropertyDescriptor(captured, Symbol.for('thunderbolt.webkitOwnPropertyCompat')).value`,
      context,
    ),
  ).toBe(true)
  expect(runInContext(`(() => { try { captured('x'); } catch (error) { return error.name; } })()`, context)).toBe(
    'TypeError',
  )
})

it('protects copied classic and module worker assets without needing window', () => {
  for (const name of ['worker.js', 'pdf.worker.min.mjs']) {
    const context = createContext({ navigator })
    runInContext(addWebKitCompatToAsset(name, Buffer.from('const captured = Object.hasOwn;')).toString(), context)
    expect(runInContext('captured({ x: undefined }, "x")', context)).toBe(true)
    expect(runInContext('captured.name', context)).toBe('hasOwn')
  }
})

it('offsets worker source maps and leaves WASM bytes unchanged', () => {
  const map = { version: 3, sources: ['worker.ts'], names: [], mappings: 'AAAA;AACA' }
  const prefixed = JSON.parse(
    addWebKitCompatToAsset('worker.js.map', Buffer.from(JSON.stringify(map))).toString(),
  ) as typeof map
  expect(prefixed).toEqual({ ...map, mappings: ';'.repeat(webkitCompatScript.split('\n').length - 1) + map.mappings })
  const wasm = Buffer.from([0, 97, 115, 109])
  expect(addWebKitCompatToAsset('sqlite.wasm', wasm)).toBe(wasm)
})
