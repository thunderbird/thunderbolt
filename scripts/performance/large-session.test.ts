/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('the CLI rejects the removed WebKit mode instead of silently benchmarking another engine', () => {
  const result = Bun.spawnSync(
    [process.execPath, fileURLToPath(new URL('./large-session.ts', import.meta.url)), '--engine', 'webkit'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("Unknown option '--engine'")
})
