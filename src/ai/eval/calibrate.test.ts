/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCalibration } from './calibrate'
import { loadCalibrationFixtures } from './fixtures'
import type { JudgeVerdict } from './judge'

const verdictFor = (expected: Partial<JudgeVerdict>): JudgeVerdict => ({
  correct: null,
  searchOffer: null,
  freshnessCaveat: null,
  evidenceCoverage: null,
  reuseFidelity: null,
  premiseRebuttal: null,
  verificationDisclaimer: null,
  replyLanguageMatches: null,
  explanation: 'injected calibration verdict',
  ...expected,
})

test('loads all frozen fixture cases including exact PoC counterexamples', () => {
  const fixtures = loadCalibrationFixtures()
  expect(fixtures).toHaveLength(8)
  expect(new Set(fixtures.map(({ id }) => id)).size).toBe(8)
  const contradiction = fixtures.find(({ id }) => id === 'contradicted-number')!
  expect(contradiction.conversation[0].responseText).toContain('≤3 users')
  expect(contradiction.conversation[0].evidence[0].text).toContain('$0 for up to 6 users')
  const invalid = fixtures.find(({ id }) => id === 'invalid-source-used-as-support')!
  expect(invalid.conversation[0].evidence[0].text).toContain('Page Not Found')
  expect(invalid.expected.evidenceCoverage).toBe(false)
  expect(fixtures.find(({ id }) => id === 'valid-technical-page-about-404')!.expected.evidenceCoverage).toBe(true)
  expect(fixtures.find(({ id }) => id === 'honest-incompleteness')!.expected.evidenceCoverage).toBe(false)
})

test('calibration refuses without explicit opt-in before calling the injected judge', async () => {
  const calls: string[] = []
  await expect(
    runCalibration({
      enabled: false,
      evaluate: async (fixture) => {
        calls.push(fixture.id)
        return verdictFor(fixture.expected)
      },
      write: () => {},
    }),
  ).rejects.toThrow('EVAL_JUDGE_CALIBRATION=1')
  expect(calls).toHaveLength(0)
})

test('calibration matches unchanged fixtures despite undeclared correctness on freshness cases', async () => {
  const lines: string[] = []
  expect(
    await runCalibration({
      enabled: true,
      evaluate: async (fixture) =>
        verdictFor({
          ...fixture.expected,
          ...(fixture.id.includes('freshness-caveat') ? { correct: true } : {}),
        }),
      write: (line) => {
        lines.push(line)
      },
    }),
  ).toBe(0)
  expect(lines).toHaveLength(10)
  expect(lines.join('\n')).not.toContain('MISMATCH')
})

test('calibration returns a nonzero mismatch exit code with an injected judge', async () => {
  const lines: string[] = []
  expect(
    await runCalibration({
      enabled: true,
      evaluate: async (fixture) =>
        verdictFor({
          ...fixture.expected,
          ...(fixture.id === 'contradicted-number' ? { evidenceCoverage: true } : {}),
        }),
      write: (line) => {
        lines.push(line)
      },
    }),
  ).toBe(1)
  expect(lines.find((line) => line.includes('contradicted-number'))).toContain('MISMATCH')
})

test('plain calibration entrypoint sends its signed bearer through the real managed judge transport', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eval-calibration-'))
  const preload = join(directory, 'transport.ts')
  writeFileSync(
    preload,
    `
    import { strict as assert } from 'node:assert'
    Reflect.deleteProperty(globalThis, 'localStorage')
    const verdicts = ${JSON.stringify(loadCalibrationFixtures().map(({ expected }) => verdictFor(expected)))}
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://calibration.invalid/v1/chat/completions')
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-signed-calibration-token')
      assert.equal(JSON.parse(init.body).stream, true)
      console.log('AUTH_OK')
      const chunk = { id: 'judge', object: 'chat.completion.chunk', created: 0, model: 'judge',
        choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(verdicts.shift()) }, finish_reason: 'stop' }] }
      return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n' + 'data: [DONE]\\n\\n',
        { headers: { 'Content-Type': 'text/event-stream' } })
    }
  `,
  )
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--preload',
      './scripts/lingui-macro-bun-shim.ts',
      '--preload',
      preload,
      'src/ai/eval/calibrate.ts',
    ],
    {
      cwd: join(import.meta.dir, '../../..'),
      env: {
        ...process.env,
        EVAL_JUDGE_CALIBRATION: '1',
        EVAL_AUTH_TOKEN: 'synthetic-signed-calibration-token',
        VITE_THUNDERBOLT_CLOUD_URL: 'http://calibration.invalid/v1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const timeout = setTimeout(() => child.kill(), 3000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.match(/AUTH_OK/g)).toHaveLength(8)
    expect(stdout).not.toContain('MISMATCH')
  } finally {
    clearTimeout(timeout)
    rmSync(directory, { recursive: true, force: true })
  }
})
