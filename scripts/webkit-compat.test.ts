/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Glob } from 'bun'
import { expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createContext, runInContext } from 'node:vm'
import viteConfig from '../vite.config'
import {
  addWebKitCompatToAsset,
  importsWithoutPreload,
  resolvePreloadDependencies,
  webkitCompatScript,
} from './webkit-compat'

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

it('builds the side panel viewers without script preloads and keeps them for every other chunk', () => {
  expect(viteConfig.build?.modulePreload).toEqual({ resolveDependencies: resolvePreloadDependencies })
  const deps = ['assets/Page-C3xkPq1a.js', 'assets/use-view-size-cyKicmT4.js']
  for (const viewer of ['pdf-sidebar-viewer', 'xlsx-preview', 'pdf-thumbnail', 'docx-snapshot', 'pptx-snapshot']) {
    expect(resolvePreloadDependencies(`assets/${viewer}-BqQwqGjR.js`, deps)).toEqual([])
  }
  expect(resolvePreloadDependencies('assets/settings-BqQwqGjR.js', deps)).toEqual(deps)
})

it('names only modules the app imports dynamically', () => {
  const root = path.join(import.meta.dir, '..')
  const sources = Array.from(new Glob('src/**/*.{ts,tsx}').scanSync(root)).filter((file) => !/\.test\.tsx?$/.test(file))
  // Each `import('…')` target as a path from the root, without its extension.
  const targets = sources.flatMap((file) =>
    Array.from(readFileSync(path.join(root, file), 'utf8').matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g), ([, spec]) =>
      spec.startsWith('@/') ? path.join('src', spec.slice(2)) : path.join(path.dirname(file), spec),
    ),
  )
  const isModule = (target: string) =>
    ['.ts', '.tsx', '/index.ts'].some((suffix) => existsSync(path.join(root, target + suffix)))
  const missing = importsWithoutPreload.filter(
    (name) => !targets.some((target) => path.basename(target) === name && isModule(target)),
  )
  expect(missing).toEqual([])
})
