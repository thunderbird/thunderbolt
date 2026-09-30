#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { linear } from '../notify-on-failure'
import { type Finding, findingSchema, fingerprint, type Severity, severity } from './findings'
import type { Verified, VerifiedFinding } from './verify'

export type Action = 'created' | 'commented' | 'regression' | 'suppressed' | 'rolled-up' | 'refused' | 'dry-run'
/** What a live run would send to Linear. */
type Preview = { title?: string; issue?: string; labels?: string[]; body: string }
/**
 * One line of `filed.json`. In a dry run `action` is `dry-run`, `would` is what a live run would do and `preview`
 * what it would send; security findings get no preview, their text only ever goes to Linear.
 */
export type Filed = {
  fp: string
  charterDir: string
  id: string
  severity: Severity
  action: Action
  would?: Action
  preview?: Preview
  issueId?: string
  identifier?: string
  url?: string
  reason?: string
}

/** Linear priority per severity; lower is more urgent, so it also sorts findings. */
export const priority = { Urgent: 1, High: 2, Medium: 3, Low: 4 } satisfies Record<Severity, number>
const maxNewTickets = 8
const regressionWindowMs = 60 * 24 * 60 * 60 * 1000
const requiredLabels = ['qa-agent', 'Bug', 'security']
const triageLabels = ['qa:valid', 'qa:not-a-bug', 'qa:duplicate', 'qa:env-artifact'] as const
const brakeMinLabelled = 8
const brakeMinPrecision = 0.5

// ---------- scorecard ----------

export type Scorecard = {
  window: string
  counts: { valid: number; notABug: number; duplicate: number; envArtifact: number }
  labelled: number
  precision: number | null
  costUsd: number | null
  costPerValid: number | null
}

const sessionSchema = z.object({ cost_usd: z.number().optional() })

/** Sum `cost_usd` over every `<charter>/session.json`; null when no session reported one. */
const sessionCost = async (outDir: string): Promise<number | null> => {
  const paths = await Array.fromAsync(new Bun.Glob('*/session.json').scan(outDir))
  const costs: number[] = []
  for (const path of paths) {
    const { cost_usd } = sessionSchema.parse(JSON.parse(await readFile(join(outDir, path), 'utf8')))
    if (cost_usd !== undefined) costs.push(cost_usd)
  }
  return costs.length ? costs.reduce((a, b) => a + b, 0) : null
}

/**
 * Precision of the last ~28 days of `qa-agent` tickets from the triage labels a human put on them:
 * valid / (valid + not-a-bug + env-artifact). Duplicates are counted but do not move precision.
 */
export const computeScorecard = async (fetchFn: typeof fetch, key: string, outDir: string): Promise<Scorecard> => {
  // ponytail: one page of 250 tickets, far above the weekly cap of 9; paginate if that ever changes
  const { issues } = await linear<{ issues: { nodes: { labels: { nodes: { name: string }[] } }[] } }>(
    fetchFn,
    key,
    `query Scorecard($since: DateTimeOrDuration!) {
      issues(first: 250, includeArchived: true, filter: { labels: { some: { name: { eq: "qa-agent" } } }, createdAt: { gte: $since } }) {
        nodes { labels { nodes { name } } }
      }
    }`,
    { since: '-P28D' },
  )
  const [valid, notABug, duplicate, envArtifact] = triageLabels.map(
    (label) => issues.nodes.filter((issue) => issue.labels.nodes.some((l) => l.name === label)).length,
  )
  const judged = valid + notABug + envArtifact
  const costUsd = await sessionCost(outDir)
  return {
    window: '28 days',
    counts: { valid, notABug, duplicate, envArtifact },
    labelled: judged + duplicate,
    precision: judged ? valid / judged : null,
    costUsd,
    costPerValid: valid && costUsd !== null ? costUsd / valid : null,
  }
}

/** True when enough tickets were judged and too many were noise: filing must stay a dry run. */
export const shouldBrake = (card: Scorecard): boolean =>
  card.labelled >= brakeMinLabelled && card.precision !== null && card.precision < brakeMinPrecision

// ---------- sanitising model-written text ----------

export const secretPattern =
  /\bsk-[\w-]{8,}|lin_(api|oauth)_\w+|gh[pousr]_\w+|github_pat_\w+|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*|xox[bp]-[\w-]+/

const keepUrl = (url: string, runUrl?: string): boolean => {
  if (runUrl && url.startsWith(runUrl)) return true
  try {
    // localhost stays so repro specs remain readable; it points nowhere outside the runner.
    return ['uploads.linear.app', 'localhost', '127.0.0.1'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Model-written text made safe for a ticket: no images, no foreign URLs, no fence breakout, capped. */
export const sanitize = (text: string, max: number, runUrl?: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)|!\[[^\]]*\]\[[^\]]*\]|<img[^>]*>/gi, '[image removed]')
    .replace(/https?:\/\/[^\s)>\]"'`]+/g, (url) => (keepUrl(url, runUrl) ? url : '[link removed]'))
    .replaceAll('```', "'''")
    .slice(0, max)

// ---------- Linear ----------

type Issue = { id: string; identifier: string; url: string }
type Existing = Issue & { completedAt: string | null; state: { type: string } }
type Decision = { kind: 'new' } | { kind: 'suppressed' } | { kind: 'commented' | 'regression'; issue: Existing }
/** What the ticket helpers shared with the fix step need. */
export type LinearAuth = { fetchFn: typeof fetch; key: string }
type Ctx = LinearAuth & { teamId: string; triageId: string; labels: Map<string, string> }

/** Resolve team, Triage state and labels once, failing loudly on anything missing. */
const setup = async (fetchFn: typeof fetch, key: string): Promise<Ctx> => {
  const { teams } = await linear<{ teams: { nodes: { id: string; name: string }[] } }>(
    fetchFn,
    key,
    'query Teams { teams(first: 100) { nodes { id name } } }',
  )
  const teamId = teams.nodes.find((team) => team.name === 'Thunderbolt')?.id
  if (!teamId) throw new Error('Thunderbolt team not found')
  const data = await linear<{
    workflowStates: { nodes: { id: string }[] }
    issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] }
  }>(
    fetchFn,
    key,
    `query QaSetup($teamId: ID!, $names: [String!]!) {
      workflowStates(first: 10, filter: { team: { id: { eq: $teamId } }, type: { eq: "triage" } }) { nodes { id } }
      issueLabels(first: 250, filter: { name: { in: $names } }) { nodes { id name team { id } } }
    }`,
    { teamId, names: requiredLabels },
  )
  const triageId = data.workflowStates.nodes[0]?.id
  if (!triageId) throw new Error('Thunderbolt team has no Triage workflow state; enable Triage in the team settings')
  const labels = new Map<string, string>()
  for (const label of data.issueLabels.nodes) {
    if (!label.team || label.team.id === teamId) labels.set(label.name, label.id)
  }
  const missing = requiredLabels.filter((name) => !labels.has(name))
  if (missing.length) throw new Error(`Missing Linear labels: ${missing.join(', ')}`)
  return { fetchFn, key, teamId, triageId, labels }
}

/** Dedupe by the `[qa:<fp>]` title tag, across open, completed, canceled and archived tickets. */
const decide = async (ctx: Ctx, fp: string, now: number): Promise<Decision> => {
  const { issues } = await linear<{ issues: { nodes: Existing[] } }>(
    ctx.fetchFn,
    ctx.key,
    `query Dedupe($teamId: ID!, $needle: String!) {
      issues(first: 50, includeArchived: true, filter: { team: { id: { eq: $teamId } }, title: { containsIgnoreCase: $needle } }) {
        nodes { id identifier url completedAt state { type } }
      }
    }`,
    { teamId: ctx.teamId, needle: `[qa:${fp}]` },
  )
  const open = issues.nodes.find((n) => n.state.type !== 'completed' && n.state.type !== 'canceled')
  if (open) return { kind: 'commented', issue: open }
  if (issues.nodes.some((n) => n.state.type === 'canceled')) return { kind: 'suppressed' }
  const recent = issues.nodes
    .filter((n) => n.completedAt && now - Date.parse(n.completedAt) <= regressionWindowMs)
    .sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? ''))[0]
  return recent ? { kind: 'regression', issue: recent } : { kind: 'new' }
}

const createIssue = async (ctx: Ctx, title: string, description: string, sev: Severity, names: string[]) => {
  const { issueCreate } = await linear<{ issueCreate: { success: boolean; issue: Issue } }>(
    ctx.fetchFn,
    ctx.key,
    'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
    {
      input: {
        teamId: ctx.teamId,
        stateId: ctx.triageId,
        labelIds: names.map((name) => ctx.labels.get(name)),
        title,
        description,
        priority: priority[sev],
      },
    },
  )
  if (!issueCreate.success) throw new Error('Linear did not create the ticket')
  return issueCreate.issue
}

/** Add a comment to a Linear ticket, failing loudly when Linear refuses. */
export const addComment = async ({ fetchFn, key }: LinearAuth, issueId: string, body: string) => {
  const { commentCreate } = await linear<{ commentCreate: { success: boolean } }>(
    fetchFn,
    key,
    'mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
    { issueId, body },
  )
  if (!commentCreate.success) throw new Error('Linear did not add the comment')
}

/** Upload a replay video to Linear storage and return its asset URL; undefined when the file is missing. */
const uploadVideo = async (ctx: Ctx, path: string): Promise<string | undefined> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  const contentType = file.type.split(';')[0] || 'video/webm'
  const { fileUpload } = await linear<{
    fileUpload: {
      success: boolean
      uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] }
    }
  }>(
    ctx.fetchFn,
    ctx.key,
    `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } }
    }`,
    { contentType, filename: basename(path), size: file.size },
  )
  if (!fileUpload.success) throw new Error('Linear did not prepare the video upload')
  const { uploadUrl, assetUrl, headers } = fileUpload.uploadFile
  const response = await ctx
    .fetchFn(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000',
        ...Object.fromEntries(headers.map((h) => [h.key, h.value])),
      },
      body: file,
    })
    .catch(() => {
      throw new Error('Linear video upload request failed')
    })
  if (!response.ok) throw new Error(`Linear video upload HTTP ${response.status}`)
  return assetUrl
}

// ---------- ticket text ----------

type Entry = { v: VerifiedFinding; f: Finding; fp: string; sev: Severity }

/** Text an attacker-influenced page could have shaped; scanned for secrets before anything is sent. */
const modelText = (f: Finding, spec: string) =>
  [f.title, f.charter, ...f.steps, f.expected, f.actual, f.oracle.evidence, spec].join('\n')

/** A finding's model-written fields as its ticket shows them: sanitized, capped, and one line for short fields. */
export const ticketView = (f: Finding, runUrl?: string) => {
  const clean = (text: string, max: number) => sanitize(text, max, runUrl)
  return {
    title: clean(f.title, 120).replace(/\s+/g, ' '),
    area: f.area,
    viewport: f.viewport,
    oracle: { type: f.oracle.type, evidence: clean(f.oracle.evidence, 500) },
    steps: f.steps.slice(0, 15).map((step) => clean(step, 300).replace(/\s+/g, ' ')),
    expected: clean(f.expected, 500),
    actual: clean(f.actual, 500),
  }
}

/** Markdown body of a new ticket. Security findings carry no run link. */
const buildBody = (
  { f, sev }: Entry,
  spec: string,
  extra: { runUrl?: string; sha?: string; videoUrl?: string; regressionOf?: Existing },
): string => {
  const runUrl = f.area === 'security' ? undefined : extra.runUrl
  const view = ticketView(f, runUrl)
  return [
    extra.regressionOf &&
      `Regression: previously fixed in ${extra.regressionOf.identifier} (${extra.regressionOf.url})`,
    `**Area:** ${f.area} · **Severity:** ${sev} · **Viewport:** ${f.viewport} · **Charter:** ${sanitize(f.charter, 60, runUrl)}`,
    extra.sha && `**Commit:** ${extra.sha}`,
    runUrl && `**Run:** ${runUrl}`,
    '## Steps',
    view.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'),
    `## Expected\n${view.expected}`,
    `## Actual\n${view.actual}`,
    `## Oracle: ${f.oracle.type}\n\`\`\`\n${view.oracle.evidence}\n\`\`\``,
    `## Repro spec\n\`\`\`ts\n${sanitize(spec, 6000, runUrl)}\n\`\`\``,
    extra.videoUrl && `[Replay video](${extra.videoUrl})`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

const videoPath = (outDir: string, video: string) =>
  isAbsolute(video) || video.startsWith(outDir) ? video : join(outDir, video)

// ---------- filing ----------

export type FileOptions = {
  outDir: string
  live: boolean
  runUrl?: string
  sha?: string
  key?: string
  fetchFn?: typeof fetch
  log?: (line: string) => void
  now?: number
}

/**
 * File the confirmed findings of a run in Linear (or describe what would be filed) and write `filed.json`.
 * Needs no LLM. `live` is downgraded to a dry run when the last 28 days of triage show low precision.
 */
export const fileFindings = async (opts: FileOptions): Promise<Filed[]> => {
  const { outDir, runUrl, sha, key, fetchFn = fetch, log = console.log, now = Date.now() } = opts
  let live = opts.live
  if (live && !key) throw new Error('--live needs LINEAR_API_KEY')
  if (live && key) {
    const card = await computeScorecard(fetchFn, key, outDir)
    if (shouldBrake(card)) {
      live = false
      log(
        `PRECISION BRAKE: ${card.labelled} triaged tickets, precision ${card.precision?.toFixed(2)} < ${brakeMinPrecision}. Forcing a dry run.`,
      )
    }
  }
  const ctx = key ? await setup(fetchFn, key) : undefined
  if (!ctx) log('No LINEAR_API_KEY: skipping Linear lookups, treating every finding as new.')

  const verified: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const entries: Entry[] = verified.confirmed.map((v) => {
    const f = findingSchema.parse(v.finding)
    return { v, f, fp: fingerprint(v.finding), sev: severity(f) }
  })
  entries.sort((a, b) => priority[a.sev] - priority[b.sev] || a.fp.localeCompare(b.fp))

  const filed: Filed[] = []
  const overflow: Entry[] = []
  const baseOf = ({ v, fp, sev }: Entry) => ({ fp, severity: sev, charterDir: v.charterDir, id: v.id })
  /**
   * Records a mutation: performed when live. A dry run logs one line without the ticket text, since the job log
   * is public, and keeps the text as `preview` in `filed.json` unless the finding is a security one.
   */
  const act = async (entry: Entry, would: Action, preview: Preview, run: (ctx: Ctx) => Promise<Partial<Filed>>) => {
    if (!live || !ctx) {
      log(`[dry run] would ${would} ${entry.fp} (${entry.sev})`)
      filed.push({
        ...baseOf(entry),
        action: 'dry-run',
        would,
        preview: entry.f.area === 'security' ? undefined : preview,
      })
      return
    }
    filed.push({ ...baseOf(entry), action: would, ...(await run(ctx)) })
  }

  try {
    let newTickets = 0
    for (const entry of entries) {
      const { v, f, fp, sev } = entry
      const spec = await readFile(join(outDir, v.charterDir, f.repro_spec), 'utf8')
      if (secretPattern.test(modelText(f, spec))) {
        filed.push({ ...baseOf(entry), action: 'refused', reason: 'secret pattern in model-written text' })
        continue
      }
      const decision: Decision = ctx ? await decide(ctx, fp, now) : { kind: 'new' }
      if (decision.kind === 'suppressed') {
        filed.push({ ...baseOf(entry), action: 'suppressed', reason: 'a canceled ticket carries this fingerprint' })
        continue
      }
      if (decision.kind === 'commented') {
        const link = f.area === 'security' || !runUrl ? '' : `: ${runUrl}`
        const body = `Seen again in a QA run${link}`
        await act(entry, 'commented', { issue: decision.issue.identifier, body }, async (ctx) => {
          await addComment(ctx, decision.issue.id, body)
          return { issueId: decision.issue.id, identifier: decision.issue.identifier, url: decision.issue.url }
        })
        continue
      }
      // A security finding always gets its own ticket: the roll-up has the run link and no security label.
      if (f.area !== 'security' && newTickets >= maxNewTickets) {
        overflow.push(entry)
        continue
      }
      newTickets++
      const regressionOf = decision.kind === 'regression' ? decision.issue : undefined
      const names = ['qa-agent', 'Bug', ...(f.area === 'security' ? ['security'] : [])]
      const title = `${ticketView(f).title} [qa:${fp}]`
      const video = f.area === 'security' ? undefined : v.artifacts.video
      const preview = { title, labels: names, body: buildBody(entry, spec, { runUrl, sha, regressionOf }) }
      await act(entry, regressionOf ? 'regression' : 'created', preview, async (ctx) => {
        const videoUrl = video ? await uploadVideo(ctx, videoPath(outDir, video)) : undefined
        const body = buildBody(entry, spec, { runUrl, sha, videoUrl, regressionOf })
        const issue = await createIssue(ctx, title, body, sev, names)
        return { issueId: issue.id, identifier: issue.identifier, url: issue.url }
      })
    }

    if (overflow.length) {
      const top = overflow[0].sev
      const title = `QA agent: ${overflow.length} more finding${overflow.length > 1 ? 's' : ''} over the ${maxNewTickets}-ticket cap`
      const lines = overflow.map(({ f, fp, sev }) => `- [qa:${fp}] ${sev} · ${f.area} · ${ticketView(f).title}`)
      const description = [runUrl && `**Run:** ${runUrl}`, 'Not filed individually this run:', ...lines]
        .filter(Boolean)
        .join('\n\n')
      const issue = live && ctx ? await createIssue(ctx, title, description, top, ['qa-agent', 'Bug']) : undefined
      if (!issue) log(`[dry run] would create the roll-up "${title}"`)
      for (const entry of overflow) {
        filed.push(
          issue
            ? { ...baseOf(entry), action: 'rolled-up', issueId: issue.id, identifier: issue.identifier, url: issue.url }
            : { ...baseOf(entry), action: 'dry-run', would: 'rolled-up' },
        )
      }
    }
  } finally {
    await writeFile(join(outDir, 'filed.json'), JSON.stringify(filed, null, 2))
  }
  return filed
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const flag = (name: string) => args[args.indexOf(name) + 1]
  const outDir = flag('--out') ?? 'qa-out'
  const key = Bun.env.LINEAR_API_KEY
  if (args[0] === 'scorecard') {
    if (!key) throw new Error('Missing LINEAR_API_KEY')
    const card = await computeScorecard(fetch, key, outDir)
    await writeFile(join(outDir, 'scorecard.json'), JSON.stringify(card, null, 2))
    console.log(JSON.stringify(card, null, 2))
  } else {
    await fileFindings({
      outDir,
      live: args.includes('--live'),
      runUrl: args.includes('--run-url') ? flag('--run-url') : undefined,
      sha: Bun.env.GITHUB_SHA,
      key,
    })
  }
}
