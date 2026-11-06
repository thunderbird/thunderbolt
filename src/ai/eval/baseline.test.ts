/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  baselineDifferences,
  compareMetricsToBaselines,
  loadBaselineFiles,
  type EvalBaseline,
  writeBaselineFiles,
} from './baseline'
import { aggregateEvalMetrics } from './stats'
import { fixtureManifest, fixtureMetrics, fixtureScenario, fixtureTrial } from './test-fixtures'
import type { EvalMetrics } from './types'

const baseline = (metrics = fixtureMetrics()): EvalBaseline => ({
  schemaVersion: 4,
  generatedAt: metrics.generatedAt,
  groupKey: 'opus/pi',
  manifest: metrics.manifest,
  group: metrics.groups['opus/pi'],
})

describe('baseline files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-baseline-'))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))
  test('M1: writes and loads every distinct cell in sorted order and removes stale files', () => {
    const opus = fixtureScenario()
    const flash = { ...opus, id: 'flash/pi/chat/never', modelName: 'flash' }
    const source = aggregateEvalMetrics(fixtureManifest([opus, flash], 1), [
      fixtureTrial(opus),
      fixtureTrial(flash, 0, false),
    ])
    const path = join(directory, 'stale.json')
    writeFileSync(path, '{}')
    expect(writeBaselineFiles(source, directory, ['opus/pi', 'flash/pi'])).toEqual([
      join(directory, 'flash--pi.json'),
      join(directory, 'opus--pi.json'),
    ])
    expect(existsSync(path)).toBe(false)
    expect(loadBaselineFiles(directory)).toEqual(
      Object.fromEntries(
        ['flash/pi', 'opus/pi'].map((groupKey) => [
          groupKey,
          {
            schemaVersion: 4,
            generatedAt: source.generatedAt,
            groupKey,
            manifest: source.manifest,
            group: source.groups[groupKey],
          },
        ]),
      ),
    )
  })
  test('rejects partial metrics without changing existing files', () => {
    const source = fixtureMetrics()
    writeBaselineFiles(source, directory, ['opus/pi'])
    const existing = readFileSync(join(directory, 'opus--pi.json'), 'utf8')
    expect(() => writeBaselineFiles(source, directory, ['opus/pi', 'flash/pi'])).toThrow('partial metrics')
    expect(readFileSync(join(directory, 'opus--pi.json'), 'utf8')).toBe(existing)
    expect(readdirSync(directory)).toHaveLength(1)
    expect(() =>
      writeBaselineFiles({ ...source, manifest: { ...source.manifest, partial: true } }, directory, ['opus/pi']),
    ).toThrow('partial metrics')
  })
  test('returns no baselines for a missing directory', () =>
    expect(loadBaselineFiles(join(directory, 'missing'))).toEqual({}))
})

describe('paired comparison replaces modal pass and Wilson significance', () => {
  test.each([
    [3, 2, -1 / 3, 'regressed'],
    [2, 3, 1 / 3, 'improved'],
    [3, 3, 0, 'unchanged'],
  ] as const)('compares %d baseline passes to %d current passes', (before, after, delta, direction) => {
    const current = fixtureMetrics(after)
    const comparison = compareMetricsToBaselines(current, { 'opus/pi': baseline(fixtureMetrics(before)) })
    expect(comparison.groups['opus/pi'].comparable).toBe(true)
    const scenario = comparison.groups['opus/pi'].scenarios[fixtureScenario().id]
    expect(scenario.delta).toBeCloseTo(delta, 6)
    expect(scenario.direction).toBe(direction)
    expect(comparison.acceptance.exitCode).toBe(after === 3 ? 0 : 1)
  })
  test('missing baseline yields explicit not comparable and no delta', () => {
    const group = compareMetricsToBaselines(fixtureMetrics(), {}).groups['opus/pi']
    expect(group.reason).toBe('not comparable: baseline absent')
    expect(group.scenarios[fixtureScenario().id].delta).toBeNull()
  })
  test.each(['rubricHash', 'judgePromptVersion', 'judgeModelId', 'providerKind'] as const)(
    'rejects mismatched %s',
    (field) => {
      const current = fixtureMetrics()
      const previous = baseline(structuredClone(current))
      current.manifest[field] = 'changed'
      expect(compareMetricsToBaselines(current, { 'opus/pi': previous }).groups['opus/pi'].reason).toContain(
        `not comparable: ${field}`,
      )
    },
  )
  test.each(['samples', 'timeout', 'judgeTimeout'] as const)('rejects mismatched %s', (field) => {
    const current = fixtureMetrics()
    const previous = baseline(structuredClone(current))
    current.manifest[field]++
    expect(baselineDifferences(current.manifest, previous)).toContain(field)
  })
  test('rejects changed actual generation ID or alias', () => {
    for (const field of ['modelId', 'model', 'key'] as const) {
      const current = fixtureMetrics()
      const previous = baseline(structuredClone(current))
      current.manifest.cells[0][field] = 'changed'
      expect(baselineDifferences(current.manifest, previous)).toEqual(['cells (aliases / actual model IDs)'])
    }
  })
  test('old schemas are never reinterpreted, even if they contain similarly named values', () => {
    for (const schemaVersion of [2, 3]) {
      const previous = { ...baseline(), schemaVersion, manifest: undefined }
      const group = compareMetricsToBaselines(fixtureMetrics(), { 'opus/pi': previous }).groups['opus/pi']
      expect(group.reason).toBe('not comparable: schemaVersion')
      expect(group.scenarios[fixtureScenario().id].delta).toBeNull()
    }
  })
  test('smoke samples cannot be compared to full samples', () => {
    const current = fixtureMetrics()
    current.manifest.samples = 1
    expect(baselineDifferences(current.manifest, baseline())).toContain('samples')
  })
  test('treatments may differ and both sides are always present', () => {
    const current: EvalMetrics = fixtureMetrics()
    current.manifest.treatment = {
      generationRevision: { commit: 'next', overlayCommit: 'lab' },
      systemPromptVersion: 'new',
      WEB_BUDGET_PROMOTION: '1',
    }
    const group = compareMetricsToBaselines(current, { 'opus/pi': baseline() }).groups['opus/pi']
    expect(group.comparable).toBe(true)
    expect(group.treatment.current).toEqual(current.manifest.treatment)
    expect(group.treatment.baseline?.WEB_BUDGET_PROMOTION).toBe('0')
  })
})

test.each([0, 1, 2])('baseline comparison CLI exits with acceptance %i despite retained handles', async (code) => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-baseline-cli-'))
  const metricsPath = join(directory, 'metrics.json')
  const preload = join(directory, 'keep-alive.ts')
  writeFileSync(metricsPath, JSON.stringify({ ...fixtureMetrics(code === 0 ? 3 : 2), harnessCrashed: code === 2 }))
  writeFileSync(preload, 'setInterval(() => {}, 60000)')
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--preload',
      './scripts/lingui-macro-bun-shim.ts',
      '--preload',
      preload,
      'src/ai/eval/baseline-cli.ts',
      'compare',
      metricsPath,
      join(directory, 'absent'),
    ],
    { cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' },
  )
  const timeout = setTimeout(() => child.kill(), 3000)
  try {
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(exitCode).toBe(code)
    expect(JSON.parse(stdout).acceptance.exitCode).toBe(code)
  } finally {
    clearTimeout(timeout)
    rmSync(directory, { recursive: true, force: true })
  }
})
