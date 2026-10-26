/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Finding,
  findingSchema,
  fingerprint,
  hasOracle,
  lintReproSpec,
  loadFindings,
  parseSession,
  nativePlatformIds,
  platformIds,
  platformOf,
  type RawFinding,
  realAiCharters,
  sessionProblem,
  severity,
} from './findings'
import cases from '../journeys.json'
import platforms from '../platforms.json'
import type { QaFunction } from './report'

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
    const reply = "I wasn't able to fetch your calendar events: the Google tool returned an error."
    expect(hasOracle(variant({ oracle: { type: 'ai-reported-failure', evidence: reply } }))).toBe(true)
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

  test('passes a spec that reads a download and a screenshot without saving them', () => {
    const body = `
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('chat.md')
  const image = await page.screenshot()
  expect(image.length).toBeGreaterThan(0)`
    expect(lintReproSpec(spec(body))).toEqual([])
  })

  test('passes test.use with the allowed options written inline', () => {
    const body = `
  const viewport = { width: 390, height: 844 }
  test.use({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, 'locale': 'de-DE' })
  test.use({ baseURL: 'http://localhost:1425', timezoneId: 'Europe/Berlin', colorScheme: 'dark' })`
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
    ["test.use({ connectOptions: { wsEndpoint: 'ws://evil.test' } })", '"connectOptions" is not allowed'],
    ["test.use({ channel: 'chrome' })", '"channel" is not allowed'],
    ["test.use({ browserName: 'firefox' })", '"browserName" is not allowed'],
    ["test.use({ executablePath: '/bin/sh' })", '"executablePath" is not allowed'],
    ["test.use({ proxy: { server: 'http://evil.test' } })", 'test.use option "proxy" is not allowed'],
    ["test.use({ viewport: null, storageState: '/etc/passwd' })", 'test.use option "storageState" is not allowed'],
    ["test.use({ ...devices['Pixel 7'] })", 'test.use option "...devices[\'Pixel 7\']" is not allowed'],
    ['const options = { viewport: null }; test.use(options)', 'test.use takes one object literal'],
    [
      "const use = test.use; use({ proxy: { server: 'http://evil.test' } })",
      '"use" is allowed only as test.use({ … })',
    ],
    ['const { use } = test', '"use" is allowed only as test.use({ … })'],
    ['const wrap = (f: unknown) => f; wrap(test.use)', '"use" is allowed only as test.use({ … })'],
    ["test['use']({ viewport: null })", '"use" is not allowed'],
    ["const fixtures = test.extend({ proxy: { server: 'http://evil.test' } })", '"extend" is not allowed'],
    ["test.only('focused', async () => {})", '"only" is not allowed'],
    ["test.skip('never runs', async () => {})", '"skip" is not allowed'],
    ["test.fixme('never runs', async () => {})", '"fixme" is not allowed'],
    ["const download = await page.waitForEvent('download'); await download.saveAs('x')", '"saveAs" is not allowed'],
    ["await page.video()?.saveAs('x')", '"saveAs" is not allowed'],
    ["await page.screenshot({ path: 'x' })", '"path" is not allowed'],
    ["await page.getByRole('main').screenshot({ path: 'x' })", '"path" is not allowed'],
    ["await page.pdf({ path: 'x' })", '"path" is not allowed'],
    ["await page.context().storageState({ path: 'x' })", '"path" is not allowed'],
    ["await page.context().tracing.stop({ path: 'x' })", '"tracing" is not allowed'],
    ["const path = 'x'; await page.screenshot({ path })", '"path" is not allowed'],
    ["await page.context().browser()?.newContext({ recordHar: { path: 'x' } })", '"path" is not allowed'],
    ["await page.context().browser()?.newContext({ recordVideo: { dir: 'x' } })", '"recordVideo" is not allowed'],
    ["await page.routeFromHAR('x', { update: true })", '"routeFromHAR" is not allowed'],
    ["expect('x').toMatchSnapshot(['..', 'x.ts'])", '"toMatchSnapshot" is not allowed'],
    ["await expect(page).toHaveScreenshot(['..', 'x.png'])", '"toHaveScreenshot" is not allowed'],
    ["await expect(page.locator('body')).toMatchAriaSnapshot({ name: 'x' })", '"toMatchAriaSnapshot" is not allowed'],
    ["test.info().outputDir = 'x'", '"outputDir" is not allowed'],
    ['const cdp = await page.context().newCDPSession(page)', '"newCDPSession" is not allowed'],
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
    ['chat', 'layout', 'High'],
    ['auth', 'console-error', 'Low'],
    ['i18n', 'assert-failed', 'Low'],
    ['chat', 'ai-reported-failure', 'High'],
    ['widgets', 'ai-reported-failure', 'Medium'],
    ['layout', 'ai-reported-failure', 'Low'],
  ] as const)('%s + %s is %s', (area, type, expected) => {
    expect(severity({ ...finding, area, oracle: { type, evidence: 'quoted' } })).toBe(expected)
  })
})

describe('layout oracle', () => {
  const layoutFinding = (area: Finding['area'], evidence: string): Finding => ({
    ...finding,
    area,
    oracle: { type: 'layout', evidence },
  })

  test('an overflow is Low, a covered control takes its area severity', () => {
    expect(severity(layoutFinding('onboarding', '[qa-layout] overflow-text span "Long name"'))).toBe('Low')
    expect(severity(layoutFinding('onboarding', '[qa-layout] overflow-page body ""'))).toBe('Low')
    // The model may quote the line the way browser_console_messages prints it.
    const printed = '[ERROR] [qa-layout] overflow-text span "Long name" @ http://localhost:1424/x.js:209'
    expect(severity(layoutFinding('onboarding', printed))).toBe('Low')
    expect(severity(layoutFinding('onboarding', '[qa-layout] covered button "Continue"'))).toBe('High')
    expect(severity(layoutFinding('skills', '[qa-layout] offscreen button "Save"'))).toBe('Medium')
  })

  test('overflow is no longer an oracle', () => {
    expect(hasOracle(variant({ oracle: { type: 'overflow', evidence: 'x' } }))).toBe(false)
    expect(hasOracle(variant({ oracle: { type: 'layout', evidence: '[qa-layout] covered button "Go"' } }))).toBe(true)
  })

  test('a repro spec may import the layout helper', () => {
    const body = `
  await loginViaEmailCode(page)
  expect(await layoutProblems(page)).toEqual([])`
    const withHelper = spec(body).replace(
      '\n\ntest(',
      "\nimport { layoutProblems } from '../../../.github/qa/layout'\n\ntest(",
    )
    expect(withHelper).toContain('.github/qa/layout')
    expect(lintReproSpec(withHelper)).toEqual([])
  })

  test('a c1 spec may take the onboarding URL from the ports helper', () => {
    const body = `
  await page.goto('/')`
    const withPorts = spec(body).replace(
      '\n\ntest(',
      "\nimport { onboardingURL } from '../../../.github/qa/ports'\n\ntest.use({ baseURL: onboardingURL })\n\ntest(",
    )
    expect(withPorts).toContain('.github/qa/ports')
    expect(lintReproSpec(withPorts)).toEqual([])
  })
})

describe('visual oracle', () => {
  /** A visual finding: a screenshot the explorer took instead of a repro spec. */
  const visual = (fields: Partial<RawFinding>): RawFinding => ({
    ...finding,
    area: 'layout',
    oracle: { type: 'visual', evidence: 'The Continue button sits under the cookie banner' },
    element: 'button "Continue"',
    function: 'onboarding-name',
    screenshot: 'mcp/page-1.png',
    repro_spec: undefined,
    ...fields,
  })

  test('a visual finding needs a screenshot and no spec', () => {
    expect(findingSchema.safeParse(visual({ screenshot: 'mcp/page-1.png', repro_spec: undefined })).success).toBe(true)
    expect(findingSchema.safeParse(visual({ screenshot: undefined })).success).toBe(false)
    expect(findingSchema.safeParse({ ...finding, repro_spec: undefined }).success).toBe(false)
  })

  test("a screenshot path stays inside the session's MCP output dirs", () => {
    for (const screenshot of ['mcp-b/page-2026-10-19T16-08-14-750Z.png', 'mcp/page-1.jpeg', 'mcp/page-1.jpg']) {
      expect(findingSchema.safeParse(visual({ screenshot })).success).toBe(true)
    }
    for (const screenshot of ['../mcp/page-1.png', 'mcp/../../x.png', '/tmp/mcp/page-1.png', 'mcp/a/b.png', 'x.png']) {
      expect(findingSchema.safeParse(visual({ screenshot })).success).toBe(false)
    }
    expect(findingSchema.safeParse(visual({ screenshot: 'mcp/transcript.json' })).success).toBe(false)
  })

  test('a visual fingerprint ignores the wording and keeps the element and the function', () => {
    const a = visual({
      area: 'onboarding',
      function: 'onboarding-name',
      element: 'button "Continue"',
      oracle: { type: 'visual', evidence: 'the keyboard hides Continue' },
    })
    const b = { ...a, oracle: { type: 'visual', evidence: 'Continue sits under the keyboard' } }
    expect(fingerprint(a)).toBe(fingerprint(b))
    expect(fingerprint({ ...a, element: 'textbox "Name"' })).not.toBe(fingerprint(a))
    expect(fingerprint({ ...a, function: 'onboarding-theme' })).not.toBe(fingerprint(a))
  })
})

describe('native findings', () => {
  /** A finding from the iOS app, proven by a Maestro flow. */
  const native = (fields: Partial<RawFinding>): RawFinding => ({
    ...finding,
    viewport: 'ios',
    repro_spec: undefined,
    repro_flow: 'repro/1.yaml',
    ...fields,
  })
  const accepted = (fields: Partial<RawFinding>) => findingSchema.safeParse(native(fields)).success

  test('a repro flow stays inside the session repro dir', () => {
    expect(accepted({})).toBe(true)
    for (const repro_flow of ['../repro/1.yaml', 'repro/../x.yaml', 'repro/a/1.yaml', 'flows/1.yaml', 'repro/1.yml']) {
      expect(accepted({ repro_flow }), repro_flow).toBe(false)
    }
  })

  const problem = (charterDir: string, fields: Partial<RawFinding>) =>
    sessionProblem({ charterDir, id: '1', finding: native(fields) })
  const spec = { repro_flow: undefined, repro_spec: 'repro/1.spec.ts' }

  test('the session dir decides the proof: a flow on a device, a spec on the web, never both', () => {
    expect(accepted({ repro_spec: 'repro/1.spec.ts' })).toBe(false)
    expect(accepted({ repro_flow: undefined })).toBe(false)
    expect(problem('c2-chat-power-user-ios', {})).toBeUndefined()
    expect(problem('c2-chat-power-user-ios', spec)).toContain('repro_flow')
    expect(problem('c2-chat-power-user-desktop', { ...spec, viewport: 'desktop' })).toBeUndefined()
    expect(problem('c2-chat-power-user-desktop', { viewport: 'desktop' })).toContain('repro_spec')
  })

  test("a finding fits a real session dir whatever its viewport says, since replay takes the dir's platform", () => {
    expect(problem('c2-chat-power-user-android', {})).toBeUndefined()
    expect(problem('c2-chat', {})).toBe('not a session dir: c2-chat')
    expect(problem('x.c2-chat-power-user-ios', {})).toBe('not a session dir: x.c2-chat-power-user-ios')
  })

  test('only the c7 session on Android takes either proof, whatever charter the finding claims', () => {
    expect(problem('c7-two-devices-android', { ...spec, viewport: 'android' })).toBeUndefined()
    expect(problem('c7-two-devices-android', { viewport: 'android' })).toBeUndefined()
    expect(problem('c2-chat-power-user-ios', { ...spec, charter: 'c7-two-devices' })).toContain('only c7')
  })

  test("a native screenshot is the gate's maestro/shot-<n> file", () => {
    for (const screenshot of ['maestro/shot-3.png', 'maestro/shot-12.jpg', 'maestro/shot-1.jpeg']) {
      expect(accepted({ oracle: { type: 'visual', evidence: 'cut off' }, repro_flow: undefined, screenshot })).toBe(
        true,
      )
    }
    for (const screenshot of ['maestro/../x.png', 'maestro/page-1.png', 'maestro/shot-1.gif', 'maestro/a/shot-1.png']) {
      expect(accepted({ oracle: { type: 'visual', evidence: 'cut off' }, screenshot }), screenshot).toBe(false)
    }
  })
})

test('each charter names exactly the functions of its list, and says the AI is real only for a real-AI charter', async () => {
  const lists: Record<string, QaFunction[]> = await Bun.file(join(import.meta.dir, '../functions.json')).json()
  for (const [charter, list] of Object.entries(lists)) {
    const text = await Bun.file(join(import.meta.dir, `../charters/${charter}.md`)).text()
    const named = [...text.matchAll(/Functions?:((?:\s+`[\w-]+`[,.]?)+)/g)].flatMap(([, ids]) => ids.match(/[\w-]+/g))
    expect([...new Set(named)].sort(), charter).toEqual(list.map((fn) => fn.id).sort())
    const real = platformIds
      .filter((platform) => platformOf(platform).realAi)
      .map((platform) => realAiCharters.has(`${charter}-${platform}`))
    // A charter is real AI on every platform that has real providers, or on none.
    expect(text.includes('the AI is **real**'), charter).toBe(real.every(Boolean))
    expect(new Set(real).size, charter).toBe(1)
  }
  const charters = [...realAiCharters]
    .map((session) => parseSession(session).charter)
    .filter((c) => !c.startsWith('free-'))
  expect(charters.filter((charter) => !(charter in lists))).toEqual([])
})

test('parseSession splits the platform off the last hyphen', () => {
  expect(parseSession('c1-first-run-phone')).toEqual({ charter: 'c1-first-run', platform: 'phone' })
  expect(parseSession('free-trip-planner-desktop')).toEqual({ charter: 'free-trip-planner', platform: 'desktop' })
  expect(() => parseSession('c1-first-run')).toThrow('unknown platform in session id: c1-first-run')
})

test('platformOf finds a platform and throws for an unknown id', () => {
  expect(platformOf('ios')).toMatchObject({ driver: 'maestro', runner: 'macos-latest', realAi: false })
  expect(() => platformOf('tablet')).toThrow('unknown platform: tablet')
  expect(nativePlatformIds).toEqual(['ios', 'android'])
})

test('real-AI sessions carry their platform', () => {
  expect(realAiCharters.has('c3-models-providers-phone')).toBe(true)
  expect(realAiCharters.has('c3-models-providers-ios')).toBe(false)
  expect(realAiCharters.has('free-trip-planner-android')).toBe(true)
  expect(realAiCharters.has('c3-models-providers')).toBe(false)
  expect(realAiCharters.has('c2-chat-power-user-desktop')).toBe(false)
})

test('a finding names a known platform', () => {
  expect(findingSchema.safeParse({ ...finding, viewport: 'phone' }).success).toBe(true)
  expect(findingSchema.safeParse({ ...finding, viewport: 'tablet' }).success).toBe(false)
})

test('every free session is real AI where the platform has real providers, and every case is complete', async () => {
  for (const { id, driver, realAi, viewport, mcp } of platforms) {
    // A session id is free-<case>-<platform>; a platform id without hyphens keeps the case readable before it.
    expect(id).toMatch(/^[a-z]+$/)
    expect(cases.every((c) => realAiCharters.has(`free-${c.id}-${id}`))).toBe(realAi)
    const repro = nativePlatformIds.includes(id) ? { repro_spec: undefined, repro_flow: 'repro/1.yaml' } : {}
    expect(findingSchema.safeParse({ ...finding, ...repro, viewport: id }).success, id).toBe(true)
    if (driver === 'playwright') expect(viewport).toMatch(/^\d+x\d+$/)
    // The Maestro config arrives with the native tasks.
    if (driver === 'playwright') expect(await Bun.file(join(import.meta.dir, '../../..', mcp)).exists()).toBe(true)
  }
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
  for (const { id, who, goal, crosses, pt } of cases) {
    expect([id, who, goal, pt].every((text) => text.trim() !== '') && crosses.length > 0, id).toBe(true)
  }
})
