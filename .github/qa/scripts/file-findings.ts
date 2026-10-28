#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { linear } from '../../../scripts/notify-on-failure'
import { type Finding, findingSchema, fingerprint, platformIds, type Severity, severity } from './findings'
import { sanitize, secretPattern } from './sanitize'
import { imageInfo, screenshotPath, type Verified, type VerifiedFinding } from './verify'

export type Action = 'created' | 'commented' | 'regression' | 'suppressed' | 'rolled-up' | 'refused' | 'dry-run'
type Preview = { title?: string; issue?: string; labels?: string[]; body: string }
/** One `filed.json` entry. Security findings get no dry-run preview: their text only ever goes to Linear. */
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

/** Linear's scale: lower is more urgent, which also makes it the sort order. */
export const priority = { Urgent: 1, High: 2, Medium: 3, Low: 4 } satisfies Record<Severity, number>
/** Separate caps so neither kind crowds out the other. */
const ticketCap = { bug: 8, security: 3 }
const regressionWindowMs = 60 * 24 * 60 * 60 * 1000
/** Linear matches label names exactly, case included. */
export const qaLabels = {
  agent: 'qa-agent',
  bug: 'Bug',
  security: 'Security',
  humanRequired: 'Human Required',
} as const
const requiredLabels = [qaLabels.agent, qaLabels.bug, qaLabels.security, qaLabels.humanRequired]
const triageLabels = ['qa:valid', 'qa:not-a-bug', 'qa:duplicate', 'qa:env-artifact'] as const
const brakeMinLabelled = 8
const brakeMinPrecision = 0.7

// ---------- scorecard ----------

export type Scorecard = {
  window: string
  counts: { valid: number; notABug: number; duplicate: number; envArtifact: number }
  labelled: number
  precision: number | null
}

/**
 * Precision over the last 28 days of `qa-agent` tickets: valid / (valid + not-a-bug + env-artifact).
 * Duplicates are counted but move neither precision nor the sample (`labelled`).
 */
export const computeScorecard = async (fetchFn: typeof fetch, key: string): Promise<Scorecard> => {
  // shortcut: one page of 250 tickets, far above the weekly cap of 9; paginate if that ever changes
  const { issues } = await linear<{ issues: { nodes: { labels: { nodes: { name: string }[] } }[] } }>(
    fetchFn,
    key,
    `query Scorecard($since: DateTimeOrDuration!, $label: String!) {
      issues(first: 250, includeArchived: true, filter: { labels: { some: { name: { eq: $label } } }, createdAt: { gte: $since } }) {
        nodes { labels { nodes { name } } }
      }
    }`,
    { since: '-P28D', label: qaLabels.agent },
  )
  const [valid, notABug, duplicate, envArtifact] = triageLabels.map(
    (label) => issues.nodes.filter((issue) => issue.labels.nodes.some((l) => l.name === label)).length,
  )
  const judged = valid + notABug + envArtifact
  return {
    window: '28 days',
    counts: { valid, notABug, duplicate, envArtifact },
    labelled: judged,
    precision: judged ? valid / judged : null,
  }
}

export const shouldBrake = (card: Scorecard): boolean =>
  card.labelled >= brakeMinLabelled && card.precision !== null && card.precision < brakeMinPrecision

// ---------- Linear ----------

type Issue = { id: string; identifier: string; url: string }
type Existing = Issue & { completedAt: string | null; state: { type: string } }
type Decision = { kind: 'new' } | { kind: 'suppressed' } | { kind: 'commented' | 'regression'; issue: Existing }
export type LinearAuth = { fetchFn: typeof fetch; key: string }
type Ctx = LinearAuth & { teamId: string; backlogId: string; labels: Map<string, string> }

/** Resolve team, Backlog state and labels once. */
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
      workflowStates(first: 10, filter: { team: { id: { eq: $teamId } }, type: { eq: "backlog" } }) { nodes { id } }
      issueLabels(first: 250, filter: { name: { in: $names } }) { nodes { id name team { id } } }
    }`,
    { teamId, names: requiredLabels },
  )
  const backlogId = data.workflowStates.nodes[0]?.id
  if (!backlogId) throw new Error('Thunderbolt team has no workflow state of type backlog to file new tickets in')
  const labels = new Map<string, string>()
  for (const label of data.issueLabels.nodes) {
    if (!label.team || label.team.id === teamId) labels.set(label.name, label.id)
  }
  const missing = requiredLabels.filter((name) => !labels.has(name))
  if (missing.length) throw new Error(`Missing Linear labels: ${missing.join(', ')}`)
  return { fetchFn, key, teamId, backlogId, labels }
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

const labelId = (ctx: Ctx, name: string) => {
  const id = ctx.labels.get(name)
  if (!id) throw new Error(`Missing Linear label: ${name}`)
  return id
}

const createIssue = async (ctx: Ctx, title: string, description: string, sev: Severity, names: string[]) => {
  const { issueCreate } = await linear<{ issueCreate: { success: boolean; issue: Issue } }>(
    ctx.fetchFn,
    ctx.key,
    'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
    {
      input: {
        teamId: ctx.teamId,
        stateId: ctx.backlogId,
        labelIds: names.map((name) => labelId(ctx, name)),
        title,
        description,
        priority: priority[sev],
      },
    },
  )
  if (!issueCreate.success) throw new Error('Linear did not create the ticket')
  return issueCreate.issue
}

export const addComment = async ({ fetchFn, key }: LinearAuth, issueId: string, body: string) => {
  const { commentCreate } = await linear<{ commentCreate: { success: boolean } }>(
    fetchFn,
    key,
    'mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
    { issueId, body },
  )
  if (!commentCreate.success) throw new Error('Linear did not add the comment')
}

/** The model chose the screenshot, so an image's content type comes from its bytes, never from its name. */
const uploadAsset = async (ctx: Ctx, path: string): Promise<string | undefined> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  const bytes = Buffer.from(await file.arrayBuffer())
  const videoTypes = new Map([
    ['.webm', 'video/webm'],
    ['.mp4', 'video/mp4'],
  ])
  const contentType = imageInfo(bytes)?.mediaType ?? videoTypes.get(extname(path))
  if (!contentType) throw new Error(`not a PNG, JPEG, WebM or MP4 file: ${basename(path)}`)
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
    { contentType, filename: basename(path), size: bytes.length },
  )
  if (!fileUpload.success) throw new Error('Linear did not prepare the upload')
  const { uploadUrl, assetUrl, headers } = fileUpload.uploadFile
  const response = await ctx
    .fetchFn(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000',
        ...Object.fromEntries(headers.map((h) => [h.key, h.value])),
      },
      body: bytes,
    })
    .catch(() => {
      throw new Error('Linear upload request failed')
    })
  if (!response.ok) throw new Error(`Linear upload HTTP ${response.status}`)
  return assetUrl
}

// ---------- ticket text ----------

/** Findings sharing a fingerprint, filed as one ticket. `v` and `f` are the most severe and give it its text. */
type Entry = {
  v: VerifiedFinding
  f: Finding
  fp: string
  sev: Severity
  /** The group's platforms, in `platforms.json` order. */
  platforms: string[]
  group: VerifiedFinding[]
}
type Overflow = { bug: Entry[]; security: Entry[] }

/** Text an attacker-influenced page could have shaped; scanned for secrets before anything is sent. */
const modelText = (f: Finding, spec: string) =>
  [f.title, f.charter, ...f.steps, f.expected, f.actual, f.oracle.evidence, f.element ?? '', spec].join('\n')

/** The model-written fields as the ticket shows them, sanitized and capped. */
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

/** The charter is the session's directory, not model text, so a free session's ticket names its case and platform. */
const buildBody = (
  { v, f, sev, platforms }: Entry,
  spec: string,
  extra: { runUrl?: string; sha?: string; videoUrl?: string; screenshotUrl?: string; regressionOf?: Existing },
): string => {
  const runUrl = f.area === 'security' ? undefined : extra.runUrl
  const view = ticketView(f, runUrl)
  return [
    extra.regressionOf &&
      `Regression: previously fixed in ${extra.regressionOf.identifier} (${extra.regressionOf.url})`,
    `**Area:** ${f.area} · **Severity:** ${sev} · ${platformsLine(platforms)} · **Charter:** ${sanitize(v.charterDir, 60, runUrl)}`,
    f.element && `**Element:** ${sanitize(f.element, 80, runUrl).replace(/\s+/g, ' ')}`,
    extra.sha && `**Commit:** ${extra.sha}`,
    runUrl && `**Run:** ${runUrl}`,
    '## Steps',
    view.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'),
    `## Expected\n${view.expected}`,
    `## Actual\n${view.actual}`,
    `## Oracle: ${f.oracle.type}\n\`\`\`\n${view.oracle.evidence}\n\`\`\``,
    spec && `## Repro spec\n\`\`\`ts\n${sanitize(spec, 6000, runUrl)}\n\`\`\``,
    extra.screenshotUrl && `![Screenshot](${extra.screenshotUrl})`,
    extra.videoUrl && `[Replay video](${extra.videoUrl})`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

const platformsLine = (platforms: string[]) => `**Platforms:** ${platforms.join(', ')}`

const videoPath = (outDir: string, video: string) =>
  isAbsolute(video) || video.startsWith(outDir) ? video : join(outDir, video)

// ---------- filing ----------

/** Runs before grouping by fingerprint, so holding back an Android finding never holds back its iOS twin. */
const refusal = (f: Finding) => {
  if (f.oracle.type === 'visual' && !(f.element?.trim() && f.function?.trim())) {
    return 'visual finding without an element and a function to deduplicate on'
  }
  // A platform files layout tickets only once its probe sweeps correct screens clean; Android's reports
  // uncovered sidebar buttons as covered.
  if (f.viewport === 'android' && f.oracle.type === 'layout') {
    return 'Android layout finding, held back until the probe sweeps correct Android screens clean'
  }
  return undefined
}

type FileOptions = {
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
 * `live` is downgraded to a dry run when the last 28 days of triage show low precision. A refused finding never
 * reaches Linear or the fix agent.
 */
export const fileFindings = async (opts: FileOptions): Promise<Filed[]> => {
  const { outDir, runUrl, sha, key, fetchFn = fetch, log = console.log, now = Date.now() } = opts
  if (opts.live && !key) throw new Error('--live needs LINEAR_API_KEY')
  const card = key ? await computeScorecard(fetchFn, key) : undefined
  if (card) await writeFile(join(outDir, 'scorecard.json'), JSON.stringify(card, null, 2))
  const braked = opts.live && card !== undefined && shouldBrake(card)
  if (braked) {
    log(
      `PRECISION BRAKE: ${card.labelled} non-duplicate triaged tickets, precision ${card.precision?.toFixed(2)} < ${brakeMinPrecision}. Forcing a dry run.`,
    )
  }
  const live = opts.live && !braked
  const ctx = key ? await setup(fetchFn, key) : undefined
  if (!ctx) log('No LINEAR_API_KEY: skipping Linear lookups, treating every finding as new.')

  const verified: Verified = await Bun.file(join(outDir, 'verified.json')).json()
  const filed: Filed[] = []
  const scored = verified.confirmed.flatMap((v) => {
    const f = findingSchema.parse(v.finding)
    const found = { v, f, fp: fingerprint(v.finding), sev: severity(f) }
    const reason = refusal(f)
    if (!reason) return [found]
    filed.push({ fp: found.fp, severity: found.sev, charterDir: v.charterDir, id: v.id, action: 'refused', reason })
    return []
  })
  scored.sort((a, b) => priority[a.sev] - priority[b.sev] || a.fp.localeCompare(b.fp))
  const entries: Entry[] = [...Map.groupBy(scored, (s) => s.fp).values()].map((group) => ({
    ...group[0],
    platforms: platformIds.filter((id) => group.some((s) => s.f.viewport === id)),
    group: group.map((s) => s.v),
  }))

  const opened = { bug: 0, security: 0 }
  const overflow: Overflow = { bug: [], security: [] }
  const record = ({ group, fp, sev }: Entry, outcome: Omit<Filed, 'fp' | 'severity' | 'charterDir' | 'id'>) =>
    filed.push(...group.map((v) => ({ fp, severity: sev, charterDir: v.charterDir, id: v.id, ...outcome })))
  /** The job log is public, so a dry run logs no ticket text; `filed.json` keeps it as `preview` unless security. */
  const act = async (
    entry: Entry,
    would: Action,
    preview: Preview,
    run: (ctx: Ctx) => Promise<Omit<Filed, 'fp' | 'severity' | 'charterDir' | 'id' | 'action'>>,
  ) => {
    if (!live || !ctx) {
      log(`[dry run] would ${would} ${entry.fp} (${entry.sev})`)
      record(entry, { action: 'dry-run', would, preview: entry.f.area === 'security' ? undefined : preview })
      return
    }
    record(entry, { action: would, ...(await run(ctx)) })
  }

  const rollUp = async (kind: keyof typeof ticketCap) => {
    const rest = overflow[kind]
    if (rest.length === 0) return
    const security = kind === 'security'
    const noun = `${security ? 'security finding' : 'finding'}${rest.length > 1 ? 's' : ''}`
    const title = `QA agent: ${rest.length} more ${noun} over the ${ticketCap[kind]}-ticket cap`
    const lines = rest.map(({ f, fp, sev }) =>
      security ? `- [qa:${fp}] ${sev}` : `- [qa:${fp}] ${sev} · ${f.area} · ${ticketView(f).title}`,
    )
    const description = [!security && runUrl && `**Run:** ${runUrl}`, 'Not filed individually this run:', ...lines]
      .filter(Boolean)
      .join('\n\n')
    const labels = [qaLabels.agent, qaLabels.bug, ...(security ? [qaLabels.security] : [])]
    const issue = live && ctx ? await createIssue(ctx, title, description, rest[0].sev, labels) : undefined
    if (!issue) log(`[dry run] would create the roll-up "${title}"`)
    for (const entry of rest) {
      record(
        entry,
        issue
          ? { action: 'rolled-up', issueId: issue.id, identifier: issue.identifier, url: issue.url }
          : { action: 'dry-run', would: 'rolled-up' },
      )
    }
  }

  try {
    for (const entry of entries) {
      const { v, f, fp, sev } = entry
      // Only this finding's text reaches Linear; the rest of its group adds platform ids, which the schema checked.
      const spec = f.repro_spec ? await readFile(join(outDir, v.charterDir, f.repro_spec), 'utf8') : ''
      if (secretPattern.test(modelText(f, spec))) {
        record(entry, { action: 'refused', reason: 'secret pattern in model-written text' })
        continue
      }
      const decision: Decision = ctx ? await decide(ctx, fp, now) : { kind: 'new' }
      if (decision.kind === 'suppressed') {
        record(entry, { action: 'suppressed', reason: 'a canceled ticket carries this fingerprint' })
        continue
      }
      if (decision.kind === 'commented') {
        const link = f.area === 'security' || !runUrl ? '' : `: ${runUrl}`
        const body = `Seen again in a QA run${link}\n\n${platformsLine(entry.platforms)}`
        await act(entry, 'commented', { issue: decision.issue.identifier, body }, async (ctx) => {
          await addComment(ctx, decision.issue.id, body)
          return { issueId: decision.issue.id, identifier: decision.issue.identifier, url: decision.issue.url }
        })
        continue
      }
      const kind = f.area === 'security' ? 'security' : 'bug'
      if (opened[kind] >= ticketCap[kind]) {
        overflow[kind].push(entry)
        continue
      }
      opened[kind]++
      const regressionOf = decision.kind === 'regression' ? decision.issue : undefined
      const visual = f.oracle.type === 'visual'
      const names = [qaLabels.agent, qaLabels.bug, ...(f.area === 'security' ? [qaLabels.security] : [])]
      const title = `${ticketView(f).title} [qa:${fp}]`
      // A security finding's video and screenshot can show what leaked; they stay in the run artifacts.
      const video = f.area === 'security' ? undefined : v.artifacts.video
      const screenshot = f.area === 'security' || !visual ? undefined : screenshotPath(outDir, v)
      const preview = { title, labels: names, body: buildBody(entry, spec, { runUrl, sha, regressionOf }) }
      await act(entry, regressionOf ? 'regression' : 'created', preview, async (ctx) => {
        const videoUrl = video ? await uploadAsset(ctx, videoPath(outDir, video)) : undefined
        const screenshotUrl = screenshot ? await uploadAsset(ctx, screenshot) : undefined
        const body = buildBody(entry, spec, { runUrl, sha, videoUrl, screenshotUrl, regressionOf })
        const issue = await createIssue(ctx, title, body, sev, names)
        return { issueId: issue.id, identifier: issue.identifier, url: issue.url }
      })
    }

    await rollUp('bug')
    await rollUp('security')
  } finally {
    await writeFile(join(outDir, 'filed.json'), JSON.stringify(filed, null, 2))
  }
  return filed
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'qa-out' },
      live: { type: 'boolean', default: false },
      'run-url': { type: 'string' },
    },
  })
  await fileFindings({
    outDir: values.out,
    live: values.live,
    runUrl: values['run-url'],
    sha: Bun.env.GITHUB_SHA,
    key: Bun.env.LINEAR_API_KEY,
  })
}
