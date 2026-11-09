/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { applyHeader, headerStatus } from './license-headers'

describe('scoped source notices', () => {
  it('selects admin scope for relative and absolute paths without catching similarly named paths', () => {
    const source = 'export const example = true\n'
    const admin = applyHeader(source, 'admin/example.ts')
    expect(headerStatus(admin, 'admin/example.ts')).toBe('valid')
    expect(headerStatus(admin, resolve(import.meta.dir, '../admin/example.ts'))).toBe('valid')
    expect(admin).toContain('info@thunderbolt.io')
    expect(admin).not.toContain('mozilla.org/MPL')
    expect(applyHeader(source, 'admin-tools/example.ts')).toContain('mozilla.org/MPL')
    expect(applyHeader(source, 'src/admin/example.ts')).toContain('mozilla.org/MPL')
  })

  it('reports scope conflicts instead of accepting or silently replacing the old notice', () => {
    const mpl = applyHeader('export {}', 'src/example.ts')
    const admin = applyHeader('export {}', 'admin/example.ts')
    expect(headerStatus(mpl, 'admin/example.ts')).toBe('conflict')
    expect(headerStatus(admin, 'src/example.ts')).toBe('conflict')
    expect(() => applyHeader(mpl, 'admin/example.ts')).toThrow('Conflicting source notice')
    expect(applyHeader(admin, 'admin/example.ts')).toBe(admin)
  })

  it('does not mistake a license mentioned in code for a source notice', () => {
    expect(headerStatus('const text = "mozilla.org/MPL"', 'src/example.ts')).toBe('missing')
    expect(headerStatus('const text = "UNLICENSED"', 'admin/example.ts')).toBe('missing')
  })

  it.each(['/* eslint-disable no-console */', '/// <reference types="vite/client" />', '// @ts-nocheck'])(
    '%s does not hide an existing notice',
    (directive) => {
      const source = `${directive}\n\n/* SPDX-License-Identifier: MPL-2.0 */\nexport {}`
      expect(headerStatus(source, 'src/example.ts')).toBe('valid')
      expect(applyHeader(source, 'src/example.ts')).toBe(source)
      expect(headerStatus(source, 'admin/example.ts')).toBe('conflict')
    },
  )

  it('does not scan past executable code or beyond the first license notice', () => {
    const source = '/* eslint-disable no-console */\nexport const text = "UNLICENSED"'
    expect(headerStatus(source, 'src/example.ts')).toBe('missing')
    const licensed = applyHeader(source, 'src/example.ts')
    expect(headerStatus(`${licensed}\n/* UNLICENSED */`, 'src/example.ts')).toBe('valid')
    const documented = applyHeader('', 'src/example.ts') + '/** The admin feature is UNLICENSED. */\nexport {}'
    expect(headerStatus(documented, 'src/example.ts')).toBe('valid')
  })

  it('keeps a conflicting notice behind a directive intact', () => {
    const source = '/* eslint-disable */\n/* SPDX-License-Identifier: MIT */\nexport {}'
    expect(headerStatus(source, 'src/example.ts')).toBe('conflict')
    expect(() => applyHeader(source, 'src/example.ts')).toThrow('Conflicting source notice')
  })

  it('recognizes notices after shebangs, directives, and Astro frontmatter', () => {
    for (const [path, source] of [
      ['admin/task.sh', '#!/bin/sh\necho hello'],
      ['admin/example.ts', '"use strict";\nexport {}'],
      ['admin/example.astro', '---\nconst title = "Example"\n---\n<h1>{title}</h1>'],
      ['admin/example.html', '<h1>Example</h1>'],
      ['src/task.sh', '#!/bin/sh\necho hello'],
    ]) {
      const result = applyHeader(source, path)
      expect(headerStatus(result, path)).toBe('valid')
      if (source.startsWith('#!')) {
        expect(result.startsWith('#!/bin/sh\n')).toBe(true)
      }
    }
  })
})
