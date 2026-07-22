/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createHarnessTools } from './harness.ts'

describe('createHarnessTools', () => {
  test('registers webfetch for local REPL and ACP workspace harnesses', () => {
    expect(createHarnessTools({ cwd: '/work' }).map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'webfetch',
    ])
    expect(createHarnessTools({ cwd: '/work', workspaceRoot: '/work' }).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'webfetch',
    ])
  })
})
