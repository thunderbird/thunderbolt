/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeScorecard, fileFindings, type Filed, shouldBrake } from './file-findings'
import { sanitize } from './sanitize'
import { fingerprint, type RawFinding } from './findings'
import { type CreateMessage, groupFindings, type Verified } from './verify'

const runUrl = 'https://github.com/o/r/actions/runs/1'
const now = Date.parse('2026-09-29T00:00:00Z')

const base: RawFinding = {
  title: 'Chat title disappears',
  area: 'chat',
  charter: 'c2-chat',
  viewport: 'desktop',
  oracle: { type: 'page-error', evidence: 'TypeError: x is undefined' },
  steps: ['Open a chat', 'Rename it'],
  expected: 'The new title shows',
  actual: 'The page throws',
  repro_spec: 'repro/1.spec.ts',
}

type Existing = { id: string; identifier: string; url: string; completedAt: string | null; state: { type: string } }
type Handlers = {
  existing?: Record<string, Existing[]>
  labels?: string[]
  /** The team's workflow states; the fake returns the ones whose type the query asks for. */
  states?: { id: string; type: string }[]
  scorecard?: { labels: { nodes: { name: string }[] } }[]
}

type Input = { title: string; stateId: string; labelIds: string[]; description: string; priority: number }
type Vars = {
  needle?: string
  body?: string
  headers?: Record<string, string>
  input?: Input
  label?: string
  contentType?: string
  filename?: string
}

/** A function usable as `fetch` (adds the `preconnect` member Bun's type requires). */
const asFetch = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(fn, { preconnect: () => {} })

const fakeLinear = (handlers: Handlers = {}) => {
  const ops: { op: string; variables: Vars }[] = []
  const fetchFn = asFetch(async (url, init) => {
    if (String(url).includes('upload.test')) {
      ops.push({ op: 'PUT', variables: { headers: Object.fromEntries(new Headers(init?.headers)) } })
      return new Response('', { status: 200 })
    }
    const { query, variables }: { query: string; variables: Vars } = JSON.parse(String(init?.body))
    const op = /^\s*(?:query|mutation) (\w+)/.exec(query)?.[1] ?? ''
    ops.push({ op, variables })
    const data = (() => {
      if (op === 'Teams') return { teams: { nodes: [{ id: 't1', name: 'Thunderbolt' }] } }
      if (op === 'QaSetup') {
        const names = handlers.labels ?? ['qa-agent', 'Bug', 'Security', 'Human Required']
        return {
          workflowStates: {
            nodes: (handlers.states ?? [{ id: 'backlog-id', type: 'backlog' }]).filter(
              (state) => state.type === /workflowStates\([^)]*type: \{ eq: "(\w+)" \}/.exec(query)?.[1],
            ),
          },
          issueLabels: { nodes: names.map((name) => ({ id: `l-${name}`, name, team: null })) },
        }
      }
      if (op === 'Dedupe') return { issues: { nodes: handlers.existing?.[variables.needle ?? ''] ?? [] } }
      if (op === 'Scorecard') {
        return { issues: { nodes: variables.label === 'qa-agent' ? (handlers.scorecard ?? []) : [] } }
      }
      if (op === 'CreateIssue') {
        const n = ops.filter((o) => o.op === 'CreateIssue').length
        return { issueCreate: { success: true, issue: { id: `i${n}`, identifier: `THB-${n}`, url: `https://l/${n}` } } }
      }
      if (op === 'Comment') return { commentCreate: { success: true } }
      if (op === 'FileUpload') {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/x',
              assetUrl: `https://uploads.linear.app/a/${variables.filename}`,
              headers: [{ key: 'x-goog-meta', value: 'v' }],
            },
          },
        }
      }
      throw new Error(`unexpected op ${op}`)
    })()
    return new Response(JSON.stringify({ data }))
  })
  return {
    fetchFn,
    ops,
    mutations: () => ops.filter((o) => ['CreateIssue', 'Comment', 'FileUpload', 'PUT'].includes(o.op)),
  }
}

const created = (api: ReturnType<typeof fakeLinear>): Input[] =>
  api.ops.flatMap((o) => (o.op === 'CreateIssue' && o.variables.input ? [o.variables.input] : []))

const uploads = (api: ReturnType<typeof fakeLinear>): Vars[] =>
  api.ops.flatMap((o) => (o.op === 'FileUpload' ? [o.variables] : []))

/** The smallest bytes `verify.ts` reads as a 16x16 PNG, and as a 16x16 JPEG. */
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000001000000010', 'hex')
const jpeg = Buffer.from('ffd8ffc000110800100010', 'hex')

const visualVerified = (fields: Partial<RawFinding> = {}): Partial<RawFinding> => ({
  area: 'layout',
  oracle: { type: 'visual', evidence: 'The Continue button sits under the cookie banner' },
  element: 'button "Continue"',
  function: 'onboarding-name',
  screenshot: 'mcp/page-1.png',
  repro_spec: undefined,
  ...fields,
})

let outDir: string
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'qa-file-'))
})
afterEach(() => rm(outDir, { recursive: true, force: true }))

/** `priority` is what the judge proposed for that finding, written as is so a test can send a malformed one. */
type Judged = Partial<RawFinding> & { priority?: string }

const writeVerified = async (findings: Judged[], video?: string, charterDir = 'c2-chat') => {
  const confirmed = []
  for (const [i, { priority, ...fields }] of findings.entries()) {
    const finding = { ...base, ...fields }
    await mkdir(join(outDir, charterDir, 'repro'), { recursive: true })
    if (finding.screenshot) {
      await mkdir(join(outDir, charterDir, 'mcp'), { recursive: true })
      await writeFile(join(outDir, charterDir, finding.screenshot), png)
    }
    if (finding.repro_spec) {
      await writeFile(
        join(outDir, charterDir, finding.repro_spec),
        `// spec ${i}\nawait page.goto('http://localhost:1420')`,
      )
    }
    confirmed.push({
      charterDir,
      id: String(i),
      finding,
      replay: { failed: 3, runs: 3 },
      artifacts: { video },
      judge: { keep: true, reason: 'A real bug.', priority },
    })
  }
  await writeFile(
    join(outDir, 'verified.json'),
    JSON.stringify({ confirmed, flaky: [], observations: [], dropped: [] }),
  )
}

/** The evidence differs per index because the fingerprint follows the evidence text. */
const numbered = (n: number, fields: Partial<RawFinding> = {}): Partial<RawFinding>[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `Bug ${i}`,
    oracle: { type: 'page-error', evidence: `Distinct failure number ${'x'.repeat(i + 1)} in component` },
    ...fields,
  }))

const fp = (fields: Partial<RawFinding>) => fingerprint({ ...base, ...fields })
const run = (fetchFn: typeof fetch, extra: Partial<Parameters<typeof fileFindings>[0]> = {}) =>
  fileFindings({ outDir, live: true, key: 'k', runUrl, sha: 'abc123', fetchFn, log: () => {}, now, ...extra })

describe('dedupe', () => {
  test('a new finding is created in Backlog with labels, priority and no assignee', async () => {
    await writeVerified([{}])
    const api = fakeLinear()
    const [entry] = await run(api.fetchFn)
    expect(entry).toMatchObject({ action: 'created', identifier: 'THB-1', severity: 'Urgent' })
    const [input] = created(api)
    expect(input).toMatchObject({ stateId: 'backlog-id', labelIds: ['l-qa-agent', 'l-Bug'], priority: 1 })
    expect(input.title).toBe(`Chat title disappears [qa:${fp({})}]`)
    expect(input).not.toHaveProperty('assigneeId')
    expect(input.description).toContain(runUrl)
    expect(input.description).toContain('abc123')
    expect(JSON.parse(await readFile(join(outDir, 'filed.json'), 'utf8'))).toHaveLength(1)
  })

  test('an open ticket gets a "seen again" comment', async () => {
    await writeVerified([{}])
    const open = { id: 'o', identifier: 'THB-9', url: 'https://l/9', completedAt: null, state: { type: 'started' } }
    const api = fakeLinear({ existing: { [`[qa:${fp({})}]`]: [open] } })
    const [entry] = await run(api.fetchFn)
    expect(entry).toMatchObject({ action: 'commented', identifier: 'THB-9' })
    expect(api.ops.find((o) => o.op === 'Comment')?.variables.body).toContain(runUrl)
    expect(api.ops.some((o) => o.op === 'CreateIssue')).toBe(false)
  })

  test('completed within 60 days files a regression that links the old ticket', async () => {
    await writeVerified([{}])
    const done = {
      id: 'd',
      identifier: 'THB-5',
      url: 'https://l/5',
      completedAt: '2026-08-20T00:00:00Z',
      state: { type: 'completed' },
    }
    const api = fakeLinear({ existing: { [`[qa:${fp({})}]`]: [done] } })
    const [entry] = await run(api.fetchFn)
    expect(entry.action).toBe('regression')
    const [input] = created(api)
    expect(input.description).toContain('THB-5')
  })

  test('completed long ago is filed as a plain new ticket', async () => {
    await writeVerified([{}])
    const done = {
      id: 'd',
      identifier: 'THB-5',
      url: 'https://l/5',
      completedAt: '2026-01-01T00:00:00Z',
      state: { type: 'completed' },
    }
    const [entry] = await run(fakeLinear({ existing: { [`[qa:${fp({})}]`]: [done] } }).fetchFn)
    expect(entry.action).toBe('created')
  })

  test('a canceled ticket suppresses the finding and nothing is mutated', async () => {
    await writeVerified([{}])
    const canceled = {
      id: 'c',
      identifier: 'THB-2',
      url: 'https://l/2',
      completedAt: null,
      state: { type: 'canceled' },
    }
    const api = fakeLinear({ existing: { [`[qa:${fp({})}]`]: [canceled] } })
    const [entry] = await run(api.fetchFn)
    expect(entry.action).toBe('suppressed')
    expect(api.mutations()).toEqual([])
  })
})

describe('cap and roll-up', () => {
  test('files the 8 most severe, rolls the rest into one ticket', async () => {
    await writeVerified([
      ...numbered(9, { area: 'layout', oracle: { type: 'layout', evidence: 'wide' } }).map((f, i) => ({
        ...f,
        oracle: { type: 'layout', evidence: `wide ${'y'.repeat(i + 1)}` },
      })),
      { title: 'Urgent one' },
    ])
    const api = fakeLinear()
    const filed = await run(api.fetchFn)
    expect(filed[0]).toMatchObject({ severity: 'Urgent', action: 'created' })
    expect(filed.filter((f) => f.action === 'created')).toHaveLength(8)
    const rolled = filed.filter((f) => f.action === 'rolled-up')
    expect(rolled).toHaveLength(2)
    expect(new Set(rolled.map((f) => f.identifier)).size).toBe(1)
    expect(created(api)).toHaveLength(9)
  })

  test('a security finding over the cap still gets its own ticket, never the roll-up', async () => {
    await writeVerified([
      ...numbered(9),
      { title: 'Leaky thing', area: 'security', oracle: { type: 'console-error', evidence: 'boom' } },
    ])
    const api = fakeLinear()
    const filed = await run(api.fetchFn)
    expect(filed.map((f) => f.action)).toEqual([...Array(8).fill('created'), 'created', 'rolled-up'])
    const [security, rollup] = created(api).slice(-2)
    expect(security.title).toContain('Leaky thing')
    expect(security.labelIds).toContain('l-Security')
    expect(security.description).not.toContain(runUrl)
    expect(rollup.title).toContain('1 more finding')
    expect(rollup.description).not.toContain('Leaky thing')
  })

  test('security findings have their own cap of 3, then one security roll-up with fingerprints only', async () => {
    await writeVerified(numbered(5, { area: 'security' }))
    const api = fakeLinear()
    const filed = await run(api.fetchFn)
    expect(filed.map((f) => f.action)).toEqual(['created', 'created', 'created', 'rolled-up', 'rolled-up'])
    const tickets = created(api)
    expect(tickets.slice(0, 3).every((t) => t.labelIds.includes('l-Security'))).toBe(true)
    const rollup = tickets[3]
    expect(rollup.title).toBe('QA agent: 2 more security findings over the 3-ticket cap')
    expect(rollup.labelIds).toEqual(['l-qa-agent', 'l-Bug', 'l-Security'])
    expect(rollup.description).not.toContain(runUrl)
    expect(rollup.description).not.toContain('Bug ')
    expect(rollup.description).toContain(`[qa:${filed[3].fp}] High`)
  })

  test('a dry-run security roll-up leaves no finding text in the log or filed.json', async () => {
    await writeVerified(numbered(4, { area: 'security' }))
    const lines: string[] = []
    const filed = await run(fakeLinear().fetchFn, { live: false, log: (l) => lines.push(l) })
    expect(filed.map((f) => f.would)).toEqual(['created', 'created', 'created', 'rolled-up'])
    const written = lines.join('\n') + (await readFile(join(outDir, 'filed.json'), 'utf8'))
    expect(written).not.toContain('Bug ')
    expect(written).not.toContain('Distinct failure')
  })

  test('a dry run over the cap logs the roll-up without any finding text', async () => {
    await writeVerified(numbered(9))
    const lines: string[] = []
    const filed = await run(fakeLinear().fetchFn, { live: false, log: (l) => lines.push(l) })
    expect(filed.map((f) => f.would)).toEqual([...Array(8).fill('created'), 'rolled-up'])
    expect(lines.at(-1)).toBe('[dry run] would create the roll-up "QA agent: 1 more finding over the 8-ticket cap"')
    expect(lines.join('\n')).not.toContain('Bug ')
  })
})

describe('sanitizing and refusal', () => {
  test.each([
    'sk-abcdefgh12345678',
    'lin_api_abc123',
    'ghp_abc123',
    'ghs_abc123',
    'gho_abc123',
    'ghu_abc123',
    'ghr_abc123',
    'lin_oauth_abc123',
    'github_pat_abc',
    'xoxb-123-abc',
    'eyJhbGciOi.eyJzdWIiOiIx.sig',
  ])('refuses a ticket containing %s', async (secret) => {
    await writeVerified([{ actual: `token was ${secret}` }])
    const api = fakeLinear()
    const [entry] = await run(api.fetchFn)
    expect(entry.action).toBe('refused')
    expect(entry.reason).not.toContain(secret)
    expect(api.mutations()).toEqual([])
  })

  test('scans the charter too, since the ticket shows it', async () => {
    await writeVerified([{ charter: 'c2 ghs_abc123' }])
    const [entry] = await run(fakeLinear().fetchFn)
    expect(entry.action).toBe('refused')
  })

  test('strips foreign URLs and images, keeps run and Linear asset links, caps length', () => {
    const text = `![x](https://evil.test/a.png) see https://evil.test/p and ${runUrl}/job and https://uploads.linear.app/a ${'z'.repeat(50)}`
    const out = sanitize(text, 150, runUrl)
    expect(out).not.toContain('evil.test')
    expect(out).toContain(`${runUrl}/job`)
    expect(out).toContain('https://uploads.linear.app/a')
    expect(out.length).toBeLessThanOrEqual(150)
  })

  test('foreign URLs never reach the ticket', async () => {
    await writeVerified([{ actual: 'Loads https://evil.test/track and ![i](https://evil.test/i.png)' }])
    const api = fakeLinear()
    await run(api.fetchFn)
    const [input] = created(api)
    expect(input.description).not.toContain('evil.test')
  })
})

describe('security findings', () => {
  test('carry the security label and no run link and no video', async () => {
    await writeVerified([{ area: 'security', oracle: { type: 'http-5xx', evidence: 'boom' } }], 'replay/v.webm')
    await mkdir(join(outDir, 'replay'), { recursive: true })
    await writeFile(join(outDir, 'replay/v.webm'), 'video')
    const api = fakeLinear()
    await run(api.fetchFn)
    const [input] = created(api)
    expect(input.labelIds).toContain('l-Security')
    expect(input.description).not.toContain(runUrl)
    expect(api.ops.some((o) => o.op === 'FileUpload')).toBe(false)
  })
})

describe('video', () => {
  test('uploads through fileUpload and links the asset URL in the body', async () => {
    await writeVerified([{}], 'replay/v.webm')
    await mkdir(join(outDir, 'replay'), { recursive: true })
    await writeFile(join(outDir, 'replay/v.webm'), 'video')
    const api = fakeLinear()
    await run(api.fetchFn)
    expect(api.ops.find((o) => o.op === 'PUT')?.variables.headers).toMatchObject({ 'x-goog-meta': 'v' })
    const [input] = created(api)
    expect(input.description).toContain('https://uploads.linear.app/a/v.webm')
    expect(uploads(api)[0].contentType).toBe('video/webm')
  })

  test('uploads a native replay video as MP4', async () => {
    const video = 'videos/ios-c2-chat-power-user-ios-run-4.mp4'
    await writeVerified([{}], video)
    await mkdir(join(outDir, 'videos'), { recursive: true })
    await writeFile(join(outDir, video), 'video')
    const api = fakeLinear()
    await run(api.fetchFn)
    expect(uploads(api)[0].contentType).toBe('video/mp4')
    expect(created(api)[0].description).toContain('https://uploads.linear.app/a/')
  })
})

describe('one ticket per bug across platforms', () => {
  test('the same bug on desktop and phone files one ticket listing both', async () => {
    await writeVerified([{ viewport: 'desktop' }, { viewport: 'phone' }])
    const api = fakeLinear()
    const filed = await run(api.fetchFn, { live: true })
    expect(created(api)).toHaveLength(1)
    expect(created(api)[0].description).toContain('**Platforms:** desktop, phone')
    expect(filed.map((f) => [f.id, f.action, f.identifier])).toEqual([
      ['0', 'created', 'THB-1'],
      ['1', 'created', 'THB-1'],
    ])
  })

  test('a bug on a new platform, with its ticket open, comments once with the platforms in platform order', async () => {
    await writeVerified([{ viewport: 'phone' }, { viewport: 'desktop' }])
    const open = { id: 'o', identifier: 'THB-9', url: 'https://l/9', completedAt: null, state: { type: 'started' } }
    const api = fakeLinear({ existing: { [`[qa:${fp({})}]`]: [open] } })
    const filed = await run(api.fetchFn)
    const comments = api.ops.filter((o) => o.op === 'Comment')
    expect(comments).toHaveLength(1)
    expect(comments[0].variables.body).toContain('**Platforms:** desktop, phone')
    expect(filed.map((f) => [f.action, f.identifier])).toEqual([
      ['commented', 'THB-9'],
      ['commented', 'THB-9'],
    ])
  })
})

describe('one ticket per defect from the grouping call', () => {
  // The confirmed findings of a real run, where each platform worded some defects differently.
  const codeField = ['c1-first-run-desktop/1', 'c1-first-run-phone/1', 'c1-first-run-ios/1']
  const backButton = ['c1-first-run-desktop/2', 'c1-first-run-phone/2', 'c1-first-run-ios/2', 'c1-first-run-android/1']
  const locationField = ['c1-first-run-phone/3', 'c1-first-run-android/3']
  const keyboard = ['c1-first-run-android/2', 'c1-first-run-ios/3']

  const answer =
    (text: string): CreateMessage =>
    async () => ({
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 50 },
    })

  /** Groups the fixture's findings with the scripted `reply` standing in for the model, then files a dry run. */
  const fileGrouped = async (reply: string) => {
    const verified: Verified = await Bun.file(join(import.meta.dir, '../fixtures/grouping/verified.json')).json()
    for (const { charterDir, finding } of verified.confirmed) {
      if (finding.repro_spec) await Bun.write(join(outDir, charterDir, finding.repro_spec), '// spec')
    }
    const { groups } = await groupFindings(verified.confirmed, answer(reply), 2, () => {})
    await writeFile(join(outDir, 'verified.json'), JSON.stringify({ ...verified, groups }))
    return fileFindings({ outDir, live: false, log: () => {}, now })
  }

  /** Each ticket the dry run would open, by fingerprint: its severity and its platforms line. */
  const tickets = (filed: Filed[]) =>
    Object.fromEntries(
      filed.map(({ fp, severity, preview }) => [
        fp,
        [severity, /\*\*Platforms:\*\* (\w+(?:, \w+)*)/.exec(preview?.body ?? '')?.[1]],
      ]),
    )

  test('files one ticket per defect, listing every platform, under its first platform finding fingerprint', async () => {
    const filed = await fileGrouped(JSON.stringify({ groups: [codeField, backButton, locationField, keyboard] }))

    expect(filed).toHaveLength(11)
    expect(tickets(filed)).toEqual({
      c2df0dd5: ['High', 'desktop, phone, ios'],
      '32e97796': ['High', 'desktop, phone, ios, android'],
      '75fcfd86': ['High', 'phone, android'],
      '7944d694': ['High', 'ios, android'],
    })
  })

  test('a group files with the highest priority among its members', async () => {
    const filed = await fileGrouped(JSON.stringify({ groups: [codeField, backButton, locationField, keyboard] }))

    // The judge rated the Android keyboard finding Medium; the iOS one has the table's High.
    expect(filed.find((f) => f.charterDir === 'c1-first-run-android' && f.id === '2')?.severity).toBe('High')
  })

  const fingerprintTickets = {
    c2df0dd5: ['High', 'desktop, phone, ios'],
    '32e97796': ['High', 'desktop, phone, ios'],
    '75fcfd86': ['High', 'phone'],
    cfa5e25a: ['High', 'android'],
    '92ab6f2a': ['Medium', 'android'],
    ee7d67ea: ['Medium', 'android'],
    '7944d694': ['High', 'ios'],
  }
  test('a malformed answer files by fingerprint', async () => {
    expect(tickets(await fileGrouped('{"groups": "all of them"}'))).toEqual(fingerprintTickets)
  })

  test('a group that joins two areas files the whole run by fingerprint', async () => {
    const mixed = JSON.stringify({ groups: [[...codeField, ...backButton], locationField, keyboard] })
    expect(tickets(await fileGrouped(mixed))).toEqual(fingerprintTickets)
  })

  test("the ticket fingerprint follows platform order, not severity or the fingerprint's own order", async () => {
    // Two wordings of one bug; desktop gets the one whose fingerprint sorts last, and Android the more severe rating.
    const wordings = numbered(2).toSorted((a, b) => fp(b).localeCompare(fp(a)))
    await writeVerified([
      { ...wordings[0], viewport: 'desktop', priority: 'High' },
      { ...wordings[1], viewport: 'android' },
    ])
    const verified: Verified = await Bun.file(join(outDir, 'verified.json')).json()
    await writeFile(
      join(outDir, 'verified.json'),
      JSON.stringify({ ...verified, groups: [['c2-chat/0', 'c2-chat/1']] }),
    )

    const filed = await fileFindings({ outDir, live: false, log: () => {}, now })

    expect(filed.map((f) => [f.fp, f.severity])).toEqual([
      [fp(wordings[0]), 'Urgent'],
      [fp(wordings[0]), 'Urgent'],
    ])
  })
})

describe('judged priority', () => {
  test('a sign-in code field with no accessible name, judged High, files High', async () => {
    const signInCodeField: Judged = {
      title: 'Sign-in code field has no accessible name',
      area: 'auth',
      charter: 'c1-first-run-desktop',
      oracle: {
        type: 'layout',
        evidence: '[qa-layout] unnamed-control textbox "after If you received a code to log in, enter "',
      },
      steps: ['Open http://localhost:1425', 'Enter a fresh email and press Continue', 'Code entry screen shows'],
      expected: 'The code text field has an accessible name',
      actual: "The code input below 'If you received a code to log in, enter it here:' has no name",
      priority: 'High',
    }
    await writeVerified([signInCodeField], undefined, 'c1-first-run-desktop')
    const api = fakeLinear()
    const [entry] = await run(api.fetchFn)
    expect(entry).toMatchObject({ action: 'created', severity: 'High' })
    expect(created(api)[0].priority).toBe(2)
  })

  test('a malformed judge priority files at the table severity', async () => {
    await writeVerified([{ priority: 'Critical' }])
    const api = fakeLinear()
    const [entry] = await run(api.fetchFn)
    expect(entry).toMatchObject({ action: 'created', severity: 'Urgent' })
    expect(created(api)[0].priority).toBe(1)
  })

  test('one bug on several platforms files with the highest priority any of them was judged', async () => {
    await writeVerified([
      { viewport: 'desktop', priority: 'High' },
      { viewport: 'phone', priority: 'Urgent' },
    ])
    const api = fakeLinear()
    const filed = await run(api.fetchFn)
    expect(filed.map((f) => f.severity)).toEqual(['Urgent', 'Urgent'])
    expect(created(api).map((input) => input.priority)).toEqual([1])
  })
})

describe('visual findings', () => {
  test('a visual ticket is left to the fix agent, not Human Required, and shows its screenshot', async () => {
    await writeVerified([visualVerified({ screenshot: 'mcp/page-1.png' })])
    const api = fakeLinear({ labels: ['qa-agent', 'Bug', 'Security', 'Human Required'] })
    await run(api.fetchFn, { live: true })
    expect(created(api)[0].labelIds).not.toContain('l-Human Required')
    expect(created(api)[0].labelIds).toContain('l-qa-agent')
    expect(uploads(api)[0].contentType).toBe('image/png')
    expect(created(api)[0].description).toContain('![Screenshot](https://uploads.linear.app/a/page-1.png)')
    expect(created(api)[0].description).toContain('**Element:** button "Continue"')
  })

  test("the screenshot's content type comes from its bytes, not its name", async () => {
    await writeVerified([visualVerified({ screenshot: 'mcp/page-1.png' })])
    await writeFile(join(outDir, 'c2-chat', 'mcp', 'page-1.png'), jpeg)
    const api = fakeLinear()
    await run(api.fetchFn)
    expect(uploads(api)[0].contentType).toBe('image/jpeg')
    expect(api.ops.find((o) => o.op === 'PUT')?.variables.headers).toMatchObject({ 'content-type': 'image/jpeg' })
  })

  test('a screenshot that is not a PNG or JPEG is never uploaded', async () => {
    await writeVerified([visualVerified({ screenshot: 'mcp/page-1.png' })])
    await writeFile(join(outDir, 'c2-chat', 'mcp', 'page-1.png'), '<svg onload="x()">')
    const api = fakeLinear()
    await expect(run(api.fetchFn)).rejects.toThrow('not a PNG, JPEG, WebM or MP4 file')
    expect(uploads(api)).toEqual([])
  })

  test('a security visual finding uploads no screenshot', async () => {
    await writeVerified([visualVerified({ area: 'security', screenshot: 'mcp/page-1.png' })])
    const api = fakeLinear({ labels: ['qa-agent', 'Bug', 'Security', 'Human Required'] })
    await run(api.fetchFn, { live: true })
    expect(created(api)).toHaveLength(1)
    expect(uploads(api)).toEqual([])
  })

  test('only an Android covered finding is held back; its iOS twin and other Android kinds are filed', async () => {
    const covered = { type: 'layout', evidence: '[qa-layout] covered button "Preferences"' }
    const native = { oracle: covered, repro_spec: undefined, repro_flow: 'repro/1.yaml' }
    const layout = (evidence: string) => ({ ...native, viewport: 'android', oracle: { type: 'layout', evidence } })
    await writeVerified([
      { ...native, viewport: 'ios' },
      { ...native, viewport: 'android' },
      layout('[qa-layout] behind-keyboard textbox "Enter your name"'),
      layout('[qa-layout] unnamed-control button "after Connect Google"'),
      layout('[qa-layout] focus-covered textbox "Email"'),
    ])
    const api = fakeLinear()

    const filed = await run(api.fetchFn)

    const held = 'Android covered finding, held back until the probe sweeps correct Android screens clean'
    expect(filed.map((f) => [f.id, f.action, f.reason]).sort()).toEqual([
      ['0', 'created', undefined],
      ['1', 'refused', held],
      ['2', 'created', undefined],
      ['3', 'created', undefined],
      ['4', 'created', undefined],
    ])
    const platforms = created(api).map((input) => /\*\*Platforms:\*\* \w+/.exec(input.description)?.[0])
    expect(platforms.sort()).toEqual([
      '**Platforms:** android',
      '**Platforms:** android',
      '**Platforms:** android',
      '**Platforms:** ios',
    ])
  })

  test.each([
    ['without an element', { element: undefined }],
    ['with a blank element', { element: '  ' }],
    ['without a function', { function: undefined }],
    ['with an empty function', { function: '' }],
    ['with a whitespace-only function', { function: '  ' }],
  ])('a visual finding %s is refused', async (_name, fields) => {
    await writeVerified([visualVerified(fields)])
    const api = fakeLinear()
    expect(await run(api.fetchFn, { live: true })).toMatchObject([
      { action: 'refused', reason: 'visual finding without an element and a function to deduplicate on' },
    ])
    expect(created(api)).toEqual([])
  })

  test('a visual finding with an element and a function is filed', async () => {
    await writeVerified([visualVerified()])
    const api = fakeLinear()
    await run(api.fetchFn, { live: true })
    expect(created(api)).toHaveLength(1)
  })
})

describe('setup errors', () => {
  test('missing labels fail with the list', async () => {
    await writeVerified([{}])
    await expect(run(fakeLinear({ labels: ['Bug'] }).fetchFn)).rejects.toThrow(
      'Missing Linear labels: qa-agent, Security, Human Required',
    )
  })

  test('a lowercase security label does not count as Security', async () => {
    await writeVerified([{}])
    await expect(
      run(fakeLinear({ labels: ['qa-agent', 'Bug', 'security', 'Human Required'] }).fetchFn),
    ).rejects.toThrow('Missing Linear labels: Security')
  })

  test('a team without a Triage state still files, in its backlog state', async () => {
    await writeVerified([{}])
    const api = fakeLinear({
      states: [
        { id: 'started-id', type: 'started' },
        { id: 'team-backlog-id', type: 'backlog' },
      ],
    })
    await run(api.fetchFn)
    expect(created(api)[0].stateId).toBe('team-backlog-id')
  })

  test('a team with no backlog state fails loudly', async () => {
    await writeVerified([{}])
    const api = fakeLinear({ states: [{ id: 'triage-id', type: 'triage' }] })
    await expect(run(api.fetchFn)).rejects.toThrow('no workflow state of type backlog')
    expect(created(api)).toHaveLength(0)
  })
})

describe('dry run', () => {
  test('never mutates, logs one line without ticket text, and keeps the text in filed.json', async () => {
    await writeVerified([{}])
    const api = fakeLinear()
    const lines: string[] = []
    const [entry] = await run(api.fetchFn, { live: false, log: (l) => lines.push(l) })
    expect(entry).toMatchObject({ action: 'dry-run', would: 'created' })
    expect(api.mutations()).toEqual([])
    expect(lines).toEqual([`[dry run] would created ${fp({})} (Urgent)`])
    expect(entry.preview).toMatchObject({ title: `Chat title disappears [qa:${fp({})}]`, labels: ['qa-agent', 'Bug'] })
    expect(entry.preview?.body).toContain('The page throws')
    expect(JSON.parse(await readFile(join(outDir, 'filed.json'), 'utf8'))[0].preview).toEqual(entry.preview)
  })

  test("names the session's directory as the charter, so a free session's ticket shows its case", async () => {
    await writeVerified([{ charter: 'free-desktop' }], undefined, 'free-calendar-planner-desktop')
    const [entry] = await run(fakeLinear().fetchFn, { live: false })
    expect(entry.preview?.body).toContain('**Charter:** free-calendar-planner-desktop')
  })

  test('keeps no text of a security finding anywhere outside Linear', async () => {
    const leak = { area: 'security' as const, actual: 'The token list is readable', title: 'Leaky thing' }
    await writeVerified([{ ...leak, oracle: { type: 'http-5xx', evidence: 'boom' } }])
    const lines: string[] = []
    const [entry] = await run(fakeLinear().fetchFn, { live: false, log: (l) => lines.push(l) })
    expect(entry).toMatchObject({ action: 'dry-run', would: 'created' })
    expect(entry.preview).toBeUndefined()
    const written = lines.join('\n') + (await readFile(join(outDir, 'filed.json'), 'utf8'))
    expect(written).not.toContain('Leaky')
    expect(written).not.toContain('readable')
  })

  test('without a key it skips Linear entirely and says so', async () => {
    await writeVerified([{}])
    const lines: string[] = []
    const fetchFn = asFetch(async () => {
      throw new Error('no network expected')
    })
    const [entry] = await fileFindings({ outDir, live: false, fetchFn, log: (l) => lines.push(l), now })
    expect(entry.would).toBe('created')
    expect(lines[0]).toContain('No LINEAR_API_KEY')
    expect(JSON.parse(await readFile(join(outDir, 'filed.json'), 'utf8'))).toHaveLength(1)
    expect(await Bun.file(join(outDir, 'scorecard.json')).exists()).toBe(false)
  })

  test('--live without a key is an error', async () => {
    await writeVerified([{}])
    await expect(fileFindings({ outDir, live: true, log: () => {} })).rejects.toThrow('LINEAR_API_KEY')
  })
})

describe('scorecard and precision brake', () => {
  const tickets = (counts: Record<string, number>) =>
    Object.entries(counts).flatMap(([name, n]) =>
      Array.from({ length: n }, () => ({ labels: { nodes: [{ name: 'qa-agent' }, { name }] } })),
    )

  test('computes precision and counts', async () => {
    const api = fakeLinear({
      scorecard: tickets({ 'qa:valid': 2, 'qa:not-a-bug': 1, 'qa:env-artifact': 1, 'qa:duplicate': 3 }),
    })
    expect(await computeScorecard(api.fetchFn, 'k')).toEqual({
      window: '28 days',
      counts: { valid: 2, notABug: 1, duplicate: 3, envArtifact: 1 },
      labelled: 4,
      precision: 0.5,
    })
  })

  test('brakes at 8+ non-duplicate triaged tickets under 70% precision', () => {
    const card = { window: '', counts: { valid: 0, notABug: 0, duplicate: 0, envArtifact: 0 } }
    expect(shouldBrake({ ...card, labelled: 8, precision: 0.69 })).toBe(true)
    expect(shouldBrake({ ...card, labelled: 8, precision: 0.7 })).toBe(false)
    expect(shouldBrake({ ...card, labelled: 7, precision: 0 })).toBe(false)
    expect(shouldBrake({ ...card, labelled: 9, precision: null })).toBe(false)
  })

  test('duplicates do not fill the sample the brake needs', async () => {
    const api = fakeLinear({ scorecard: tickets({ 'qa:valid': 3, 'qa:not-a-bug': 4, 'qa:duplicate': 9 }) })
    const card = await computeScorecard(api.fetchFn, 'k')
    expect(card.labelled).toBe(7)
    expect(shouldBrake(card)).toBe(false)
  })

  test('a dry run with a key writes the scorecard once and does not brake', async () => {
    await writeVerified([{}])
    const api = fakeLinear({ scorecard: tickets({ 'qa:valid': 1, 'qa:not-a-bug': 7 }) })
    const lines: string[] = []
    await run(api.fetchFn, { live: false, log: (l) => lines.push(l) })
    expect(JSON.parse(await readFile(join(outDir, 'scorecard.json'), 'utf8'))).toMatchObject({ labelled: 8 })
    expect(api.ops.filter((o) => o.op === 'Scorecard')).toHaveLength(1)
    expect(lines.join('\n')).not.toContain('PRECISION BRAKE')
  })

  test('a live run under the brake becomes a dry run and says so', async () => {
    await writeVerified([{}])
    const api = fakeLinear({ scorecard: tickets({ 'qa:valid': 1, 'qa:not-a-bug': 7 }) })
    const lines: string[] = []
    const [entry] = await run(api.fetchFn, { log: (l) => lines.push(l) })
    expect(entry.action).toBe('dry-run')
    expect(lines.join('\n')).toContain('PRECISION BRAKE')
    expect(api.mutations()).toEqual([])
  })
})
