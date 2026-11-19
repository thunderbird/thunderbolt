/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { pathsOutsideScope } from './docs-audit-check-patch'

describe('pathsOutsideScope', () => {
  test('accepts a patch of docs only', () => {
    expect(pathsOutsideScope('3\t1\tdocs/faq.md\n1\t1\tAGENTS.md\n2\t0\tminiapps/x/AGENTS.md\n')).toEqual([])
  })

  test('lists every path outside the scope', () => {
    const numstat = '1\t1\tdocs/faq.md\n-\t-\tdocs/screenshots/main.png\n4\t2\tsrc/app.tsx\n1\t0\tCLAUDE.md\n'
    expect(pathsOutsideScope(numstat)).toEqual(['docs/screenshots/main.png', 'src/app.tsx', 'CLAUDE.md'])
  })

  test('rejects a rename numstat cannot attribute to one doc', () => {
    expect(pathsOutsideScope('0\t0\tdocs/{old.md => new.md}\n')).toEqual(['docs/{old.md => new.md}'])
  })

  test('accepts an empty patch', () => {
    expect(pathsOutsideScope('')).toEqual([])
  })
})
