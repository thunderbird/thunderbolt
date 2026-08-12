/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('starts the eval entrypoint with auth under plain Bun', async () => {
  const child = Bun.spawn(['bun', 'run', 'eval'], {
    cwd: join(import.meta.dir, '../../..'),
    env: {
      ...process.env,
      EVAL_AUTH_TOKEN: 'test-token',
      EVAL_MODELS: 'missing-model',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const output = `${stdout}\n${stderr}`

  expect(exitCode).toBe(1)
  expect(output).toContain('No scenarios matched the filters.')
  expect(output).not.toContain('localStorage is not defined')
}, 30_000)
