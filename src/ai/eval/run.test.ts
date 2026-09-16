/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EvalManifest } from './types'

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

test.each(['EVAL_TIMEOUT', 'EVAL_JUDGE_TIMEOUT'])('rejects invalid %s before model work', async (setting) => {
  const child = Bun.spawn(['bun', '--preload', './scripts/lingui-macro-bun-shim.ts', 'src/ai/eval/run.ts'], {
    cwd: join(import.meta.dir, '../../..'),
    env: { ...process.env, EVAL_MODELS: 'missing-model', [setting]: 'NaN' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(code).toBe(2)
  expect(stderr).toContain(`${setting} must be a positive finite number`)
})

test.each([
  ['missing-scenario', 2, 'Unknown EVAL_SCENARIOS for selected filters: missing-scenario'],
  [' answer-then-offer-08, answer-then-offer-09 ', 1, 'No scenarios matched the filters.'],
] as const)('validates scenario suffixes and intersects them with smoke (%s)', async (scenarios, code, message) => {
  const child = Bun.spawn(['bun', '--preload', './scripts/lingui-macro-bun-shim.ts', 'src/ai/eval/run.ts'], {
    cwd: join(import.meta.dir, '../../..'),
    env: {
      ...process.env,
      EVAL_AUTH_TOKEN: '',
      VITE_THUNDERBOLT_CLOUD_URL: 'http://127.0.0.1:1',
      EVAL_MODELS: 'glm',
      EVAL_SUITES: 'necessity',
      EVAL_MODES: 'chat',
      EVAL_ENGINES: 'pi',
      EVAL_SCENARIOS: scenarios,
      EVAL_SMOKE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(exitCode).toBe(code)
  expect(stderr).toContain(message)
})

test('records the exact nonempty scenario selection before any trial', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-selection-'))
  try {
    const child = Bun.spawn(['bun', '--preload', './scripts/lingui-macro-bun-shim.ts', 'src/ai/eval/run.ts'], {
      cwd: join(import.meta.dir, '../../..'),
      env: {
        ...process.env,
        EVAL_AUTH_TOKEN: '',
        VITE_THUNDERBOLT_CLOUD_URL: 'http://[invalid]',
        EVAL_MODELS: 'glm',
        EVAL_SUITES: 'necessity',
        EVAL_MODES: 'chat',
        EVAL_ENGINES: 'pi',
        EVAL_SCENARIOS: ' unknown-entity-01, never-search-01, answer-then-offer-08, never-search-01 ',
        EVAL_SMOKE: '1',
        EVAL_OUTPUT: join(directory, 'results.md'),
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    expect(await child.exited).toBe(2)
    const records = readFileSync(join(directory, 'eval-trials.jsonl'), 'utf8').trim().split('\n')
    expect(records).toHaveLength(1)
    const { manifest } = JSON.parse(records[0]) as { manifest: EvalManifest }
    expect(manifest.scenarios.map(({ scenario }) => scenario.id)).toEqual([
      'glm/pi/chat/never-search-01',
      'glm/pi/chat/unknown-entity-01',
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
