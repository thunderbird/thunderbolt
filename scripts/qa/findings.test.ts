/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Finding,
  fingerprint,
  hasOracle,
  lintReproSpec,
  loadFindings,
  type RawFinding,
  severity,
} from './findings'

const finding: Finding = {
  title: 'Chat title disappears',
  area: 'chat',
  charter: 'c2-chat-power-user',
  viewport: 'desktop',
  oracle: { type: 'page-error', evidence: "TypeError: Cannot read properties of undefined (reading 'title')" },
  steps: ['Open a chat', 'Rename it'],
  expected: 'The new title shows',
  actual: 'The page throws',
  repro_spec: 'repro/1.spec.ts',
}

/** The finding with some fields replaced. */
const variant = (fields: Partial<RawFinding>): RawFinding => ({ ...finding, ...fields })

describe('loadFindings', () => {
  test('returns valid findings with their charter and id, and rejects the rest with a reason', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'qa-findings-'))
    try {
      const write = async (path: string, content: string) => {
        await mkdir(join(outDir, path, '..'), { recursive: true })
        await writeFile(join(outDir, path), content)
      }
      await write('c2-chat/findings/1.json', JSON.stringify(finding))
      await write('c2-chat/findings/2.json', '{ "title": ')
      await write('c4-skills/findings/1.json', JSON.stringify(variant({ repro_spec: '../../../.github/x.spec.ts' })))
      await write('c4-skills/findings/3.json', JSON.stringify(variant({ oracle: { type: 'vibes', evidence: '' } })))
      await write('c4-skills/session.json', '{}')

      const { valid, rejected } = await loadFindings(outDir)

      expect(valid.map(({ charterDir, id }) => `${charterDir}/${id}`)).toEqual(['c2-chat/1', 'c4-skills/3'])
      expect(valid[0].finding).toEqual(finding)
      expect(rejected.map(({ charterDir, id }) => `${charterDir}/${id}`)).toEqual(['c2-chat/2', 'c4-skills/1'])
      expect(rejected[0].reason).toContain('not valid JSON')
      expect(rejected[1].reason).toContain('repro_spec')
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})

describe('hasOracle', () => {
  test('accepts a known oracle type with quoted evidence', () => {
    expect(hasOracle(finding)).toBe(true)
  })

  test('turns an unknown type or blank evidence into an observation', () => {
    expect(hasOracle(variant({ oracle: { type: 'looks-wrong', evidence: 'the button is ugly' } }))).toBe(false)
    expect(hasOracle(variant({ oracle: { type: 'stuck', evidence: '  ' } }))).toBe(false)
  })
})

/** A spec whose body runs inside a test that has `page`. */
const spec = (body: string) => `import { test, expect, type Page } from '@playwright/test'
import { loginViaEmailCode } from '../../../e2e/helpers'

test('repro', async ({ page }) => {
${body}
})
`

describe('lintReproSpec', () => {
  test('passes a realistic spec', () => {
    const body = `
  test.use({ viewport: { width: 390, height: 844 } })
  await loginViaEmailCode(page)
  const open = async (target: Page, name: string): Promise<void> => {
    await target.getByRole('button', { name }).click()
  }
  await open(page, 'Settings')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: window.innerWidth }))
  const { scroll: scrollWidth, client } = widths
  const rows = await page.getByRole('row').all()
  expect(rows[0]).toBeDefined()
  await expect(page.getByRole('link')).toHaveAttribute('target', '_blank')
  expect(scrollWidth, JSON.stringify({ client })).toBeLessThanOrEqual(client)`
    expect(lintReproSpec(spec(body))).toEqual([])
  })

  test.each([
    ["import { execSync } from 'node:child_process'", 'import from "node:child_process"'],
    ["import fs from 'fs'", 'import from "fs"'],
    ["import { x } from '../../../e2e/fake-provider'", 'import from "../../../e2e/fake-provider"'],
    ["import x = require('fs')", 'import = is not allowed'],
    ["export * from 'fs'", 'exports are not allowed'],
    ["const cp = require('child_process')", '"require" is not allowed'],
    ["await import('node:fs')", 'import() is not allowed'],
    ['const url = import.meta.url', '"import.meta" is not allowed'],
    ['const token = process.env.SECRET', '"process" is not allowed'],
    ['const env = Bun.env', '"Bun" is not allowed'],
    ["await fetch('https://evil.test')", '"fetch" is not allowed'],
    ["await page.evaluate(() => window.fetch('https://evil.test'))", '"fetch" is not allowed'],
    ['new XMLHttpRequest()', '"XMLHttpRequest" is not allowed'],
    ["new WebSocket('wss://evil.test')", '"WebSocket" is not allowed'],
    ["eval('1')", '"eval" is not allowed'],
    ["new Function('return 1')()", '"Function" is not allowed'],
    ['class Evil extends Function {}', '"Function" is not allowed'],
    ["const g = globalThis['pro' + 'cess']", '"globalThis" is not allowed'],
    ["const k = 'constr' + 'uctor'; const f = [][k]", 'computed member access is not allowed'],
    ["const f = [].constructor.constructor('return 1')", '"constructor" is not allowed'],
    ["const f = []['constructor']", '"constructor" is not allowed'],
    ['const { constructor: make } = []', '"constructor" is not allowed'],
    ["const { 'constructor': make } = []", '"constructor" is not allowed'],
    ["const k = 'x'; const o = { [k]: 1 }", 'computed member access is not allowed'],
    ['const channel = page.context()._connection', '"_connection" is not allowed'],
    [
      "await page.context().browser()?.browserType().launch({ args: ['--gpu-launcher=sh'] })",
      '"launch" is not allowed',
    ],
    ["test.use({ launchOptions: { args: ['--gpu-launcher=sh'] } })", '"launchOptions" is not allowed'],
    ['const o = Object.getOwnPropertyDescriptors([])', '"Object" is not a known global'],
    ['const o = Reflect.ownKeys([])', '"Reflect" is not a known global'],
    ['const o = { page, secret }', '"secret" is not a known global'],
    ['const a = arguments', '"arguments" is not a known global'],
    ['const self = (function () { return this })()', '"this" is not allowed'],
    ['declare const secrets: { read(): string }; secrets.read()', 'ambient declarations are not allowed'],
    ['const scope = {}; with (scope) {}', 'with statements are not allowed'],
    ["test('unclosed', () => {", 'syntax error'],
  ])('rejects %s', (body, reason) => {
    const reasons = lintReproSpec(spec(body))
    expect(
      reasons.some((r) => r.includes(reason)),
      reasons.join('\n'),
    ).toBe(true)
  })

  test('a local variable cannot shadow a forbidden name', () => {
    expect(lintReproSpec(spec('const process = { env: {} }'))).toContain('line 5: "process" is not allowed')
  })
})

describe('fingerprint', () => {
  test('is 8 hex characters', () => {
    expect(fingerprint(finding)).toMatch(/^[0-9a-f]{8}$/)
  })

  test('matches the same bug quoted with different run noise', () => {
    const first = variant({
      oracle: {
        type: 'http-5xx',
        evidence:
          'POST http://localhost:8005/v1/chats/0198f0a2-7b3c-4d5e-8f90-a1b2c3d4e5f6/messages?trace=ab12 500 at 2026-09-28T07:12:44.123Z (index-DyK3a9_Q.js:12:3456) req a3f9c2e1',
      },
    })
    const second = variant({
      oracle: {
        type: 'http-5xx',
        evidence:
          'POST  http://localhost:9123/v1/chats/3f2e3ba0-1111-4222-8333-444455556666/messages?trace=ffe 502\n at 2026-10-05T07:01:02Z (index-Bx9_kQ2z.js:98:7) req 77be0f4d',
      },
    })
    expect(fingerprint(first)).toBe(fingerprint(second))
  })

  test('differs for different bugs, areas and oracle types', () => {
    const other = variant({
      oracle: { type: 'page-error', evidence: "TypeError: Cannot read properties of undefined (reading 'model')" },
    })
    expect(fingerprint(other)).not.toBe(fingerprint(finding))
    expect(fingerprint(variant({ area: 'skills' }))).not.toBe(fingerprint(finding))
    expect(fingerprint(variant({ oracle: { ...finding.oracle, type: 'console-error' } }))).not.toBe(
      fingerprint(finding),
    )
  })
})

describe('severity', () => {
  test.each([
    ['chat', 'page-error', 'Urgent'],
    ['settings', 'lost-on-reload', 'Urgent'],
    ['auth', 'assert-failed', 'Urgent'],
    ['chat', 'stuck', 'High'],
    ['sync', 'http-5xx', 'High'],
    ['models', 'page-error', 'High'],
    ['skills', 'page-error', 'Medium'],
    ['data', 'assert-failed', 'Medium'],
    ['chat', 'overflow', 'Low'],
    ['auth', 'console-error', 'Low'],
    ['i18n', 'assert-failed', 'Low'],
  ] as const)('%s + %s is %s', (area, type, expected) => {
    expect(severity({ ...finding, area, oracle: { type, evidence: 'quoted' } })).toBe(expected)
  })
})
