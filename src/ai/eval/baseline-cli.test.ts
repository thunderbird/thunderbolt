/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvalMetrics } from './types'

test('exits after comparing metrics when a preload keeps the event loop alive', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'thunderbolt-eval-baseline-cli-'))
  const preloadPath = join(temporaryDirectory, 'keep-alive.ts')
  const metricsPath = join(temporaryDirectory, 'eval-metrics.json')
  const baselineDirectory = join(temporaryDirectory, 'baselines')
  const metrics = {
    schemaVersion: 3,
    generatedAt: '2026-08-13T12:00:00.000Z',
    groups: {},
  } satisfies EvalMetrics
  writeFileSync(preloadPath, 'setInterval(() => {}, 60_000)\n')
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`)

  const processHandle = Bun.spawn(
    [
      process.execPath,
      '--preload',
      preloadPath,
      'src/ai/eval/baseline-cli.ts',
      'compare',
      metricsPath,
      baselineDirectory,
    ],
    {
      cwd: join(import.meta.dir, '../../..'),
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  const completion = await Promise.race([
    (async () => ({ exitCode: await processHandle.exited }))(),
    (async () => {
      await Bun.sleep(1_000)
      return { exitCode: null }
    })(),
  ])

  if (completion.exitCode === null) {
    processHandle.kill()
    await processHandle.exited
  }
  rmSync(temporaryDirectory, { recursive: true, force: true })

  expect(completion.exitCode).toBe(0)
})
