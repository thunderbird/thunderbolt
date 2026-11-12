/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('memory eval binds custom-server credentials under plain Bun before rejecting unknown filters', async () => {
  const child = Bun.spawn(['bun', 'run', 'eval:memory'], {
    cwd: join(import.meta.dir, '../../..'),
    env: {
      ...process.env,
      EVAL_CLOUD_URL: 'http://localhost:8006/v1',
      EVAL_AUTH_TOKEN: 'invented-eval-token',
      EVAL_MODELS: 'missing-model',
      EVAL_ANONYMOUS_AUTH: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code).toBe(2)
  expect(stderr).toContain('Unknown memory eval filters')
  expect(stderr).not.toContain('selected server changed')
  expect(stderr).not.toContain('storage is currently unavailable')
  expect(stdout + stderr).not.toContain('invented-eval-token')
}, 30_000)
