/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeScorecard, fileFindings, sanitize, shouldBrake } from './file-findings'
import { fingerprint, type RawFinding } from './findings'

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
  triage?: boolean
  scorecard?: { labels: { nodes: { name: string }[] } }[]
}

type Input = { title: string; stateId: string; labelIds: string[]; description: string; priority: number }
type Vars = { needle?: string; body?: string; headers?: Record<string, string>; input?: Input }

/** A function usable as `fetch` (adds the `preconnect` member Bun's type requires). */
const asFetch = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(fn, { preconnect: () => {} })

/** Fake Linear API keyed on the GraphQL operation name; records every operation. */
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
        const names = handlers.labels ?? ['qa-agent', 'Bug', 'security']
        return {
          workflowStates: { nodes: handlers.triage === false ? [] : [{ id: 'triage-id' }] },
          issueLabels: { nodes: names.map((name) => ({ id: `l-${name}`, name, team: null })) },
        }
      }
      if (op === 'Dedupe') return { issues: { nodes: handlers.existing?.[variables.needle ?? ''] ?? [] } }
      if (op === 'Scorecard') return { issues: { nodes: handlers.scorecard ?? [] } }
      if (op === 'CreateIssue') {
        const n = ops.filter((o) => o.op === 'CreateIssue').length
        return { issueCreate: { success: true, issue: { id: `i${n}`, identifier: `THU-${n}`, url: `https://l/${n}` } } }
      }
      if (op === 'Comment') return { commentCreate: { success: true } }
      if (op === 'FileUpload') {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/x',
              assetUrl: 'https://uploads.linear.app/a/video.webm',
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

/** Inputs of every issueCreate the fake saw. */
const created = (api: ReturnType<typeof fakeLinear>): Input[] =>
  api.ops.flatMap((o) => (o.op === 'CreateIssue' && o.variables.input ? [o.variables.input] : []))

let outDir: string
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'qa-file-'))
})
afterEach(() => rm(outDir, { recursive: true, force: true }))

/** Write verified.json with these findings (plus their repro specs) as confirmed. */
const writeVerified = async (findings: Partial<RawFinding>[], video?: string) => {
  const confirmed = []
  for (const [i, fields] of findings.entries()) {
    const finding = { ...base, ...fields }
    await mkdir(join(outDir, 'c2-chat/repro'), { recursive: true })
    await writeFile(
      join(outDir, 'c2-chat', finding.repro_spec),
      `// spec ${i}\nawait page.goto('http://localhost:1420')`,
    )
    confirmed.push({
      charterDir: 'c2-chat',
      id: String(i),
      finding,
      replay: { failed: 3, runs: 3 },
      artifacts: { video },
    })
  }
  await writeFile(
    join(outDir, 'verified.json'),
    JSON.stringify({ confirmed, flaky: [], observations: [], dropped: [] }),
  )
}

/** A distinct finding per index (the fingerprint follows the evidence text). */
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
  test('a new finding is created in Triage with labels, priority and no assignee', async () => {
    await writeVerified([{}])
    const api = fakeLinear()
    const [entry] = await run(api.fetchFn)
    expect(entry).toMatchObject({ action: 'created', identifier: 'THU-1', severity: 'Urgent' })
    const [input] = created(api)
    expect(input).toMatchObject({ stateId: 'triage-id', labelIds: ['l-qa-agent', 'l-Bug'], priority: 1 })
    expect(input.title).toBe(`Chat title disappears [qa:${fp({})}]`)
    expect(input).not.toHaveProperty('assigneeId')
    expect(input.description).toContain(runUrl)
    expect(input.description).toContain('abc123')
    expect(JSON.parse(await readFile(join(outDir, 'filed.json'), 'utf8'))).toHaveLength(1)
  })

  test('an open ticket gets a "seen again" comment', async () => {
    await writeVerified([{}])
    const open = { id: 'o', identifier: 'THU-9', url: 'https://l/9', completedAt: null, state: { type: 'started' } }
    const api = fakeLinear({ existing: { [`[qa:${fp({})}]`]: [open] } })
    const [entry] = await run(api.fetchFn)
    expect(entry).toMatchObject({ action: 'commented', identifier: 'THU-9' })
    expect(api.ops.find((o) => o.op === 'Comment')?.variables.body).toContain(runUrl)
    expect(api.ops.some((o) => o.op === 'CreateIssue')).toBe(false)
  })

  test('completed within 60 days files a regression that links the old ticket', async () => {
    await writeVerified([{}])
    const done = {
      id: 'd',
      identifier: 'THU-5',
      url: 'https://l/5',
      completedAt: '2026-08-20T00:00:00Z',
      state: { type: 'completed' },
    }
    const api = fakeLinear({ existing: { [`[qa:${fp({})}]`]: [done] } })
    const [entry] = await run(api.fetchFn)
    expect(entry.action).toBe('regression')
    const [input] = created(api)
    expect(input.description).toContain('THU-5')
  })

  test('completed long ago is filed as a plain new ticket', async () => {
    await writeVerified([{}])
    const done = {
      id: 'd',
      identifier: 'THU-5',
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
      identifier: 'THU-2',
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
      ...numbered(9, { area: 'layout', oracle: { type: 'overflow', evidence: 'wide' } }).map((f, i) => ({
        ...f,
        oracle: { type: 'overflow', evidence: `wide ${'y'.repeat(i + 1)}` },
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
    expect(security.labelIds).toContain('l-security')
    expect(security.description).not.toContain(runUrl)
    expect(rollup.title).toContain('1 more finding')
    expect(rollup.description).not.toContain('Leaky thing')
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

describe('sanitising and refusal', () => {
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
    expect(input.labelIds).toContain('l-security')
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
    expect(input.description).toContain('https://uploads.linear.app/a/video.webm')
  })
})

describe('setup errors', () => {
  test('missing labels fail with the list', async () => {
    await writeVerified([{}])
    await expect(run(fakeLinear({ labels: ['Bug'] }).fetchFn)).rejects.toThrow(
      'Missing Linear labels: qa-agent, security',
    )
  })

  test('no Triage state fails loudly', async () => {
    await writeVerified([{}])
    await expect(run(fakeLinear({ triage: false }).fetchFn)).rejects.toThrow('Triage')
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

  test('computes precision, counts and cost per valid ticket', async () => {
    await mkdir(join(outDir, 'c1'), { recursive: true })
    await writeFile(join(outDir, 'c1/session.json'), JSON.stringify({ cost_usd: 4 }))
    const api = fakeLinear({
      scorecard: tickets({ 'qa:valid': 2, 'qa:not-a-bug': 1, 'qa:env-artifact': 1, 'qa:duplicate': 3 }),
    })
    const card = await computeScorecard(api.fetchFn, 'k', outDir)
    expect(card).toMatchObject({
      counts: { valid: 2, notABug: 1, duplicate: 3, envArtifact: 1 },
      labelled: 7,
      precision: 0.5,
      costPerValid: 2,
    })
  })

  test('brakes at 8+ labelled tickets under 50% precision', () => {
    const card = {
      window: '',
      counts: { valid: 0, notABug: 0, duplicate: 0, envArtifact: 0 },
      costUsd: null,
      costPerValid: null,
    }
    expect(shouldBrake({ ...card, labelled: 8, precision: 0.49 })).toBe(true)
    expect(shouldBrake({ ...card, labelled: 8, precision: 0.5 })).toBe(false)
    expect(shouldBrake({ ...card, labelled: 7, precision: 0 })).toBe(false)
    expect(shouldBrake({ ...card, labelled: 9, precision: null })).toBe(false)
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
