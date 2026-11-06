#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { linear } from '../../../scripts/notify-on-failure'
import {
  type Finding,
  findingId,
  findingSchema,
  fingerprint,
  judgedSeverity,
  platformIds,
  proposedSeveritySchema,
  type Severity,
} from './findings'
import { cleanLogLine, sanitize, secretPattern } from './sanitize'
import { imageInfo, screenshotPath, type Verified, type VerifiedFinding } from './verify'

export type Action = 'created' | 'commented' | 'regression' | 'suppressed' | 'refused' | 'dry-run'
type Preview = { title?: string; issue?: string; labels?: string[]; body: string }
/** An attachment the ticket was filed without, and the cleaned error that cost it. */
export type LostAttachment = { kind: 'video' | 'screenshot'; reason: string }
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
  lostAttachments?: LostAttachment[]
}

/** Linear's scale: lower is more urgent, which also makes it the sort order. */
export const priority = { Urgent: 1, High: 2, Medium: 3, Low: 4 } satisfies Record<Severity, number>
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

type LabelledTicket = { labels: { nodes: { name: string }[] } }

/** Every `qa-agent` ticket of the last 28 days, archived ones too, read page by page from `after`. */
const scorecardTickets = async (
  fetchFn: typeof fetch,
  key: string,
  after: string | null = null,
): Promise<LabelledTicket[]> => {
  const { issues } = await linear<{
    issues: { nodes: LabelledTicket[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  }>(
    fetchFn,
    key,
    `query Scorecard($since: DateTimeOrDuration!, $label: String!, $after: String) {
      issues(first: 250, after: $after, includeArchived: true, filter: { labels: { some: { name: { eq: $label } } }, createdAt: { gte: $since } }) {
        nodes { labels { nodes { name } } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { since: '-P28D', label: qaLabels.agent, after },
  )
  if (!issues.pageInfo.hasNextPage) return issues.nodes
  return [...issues.nodes, ...(await scorecardTickets(fetchFn, key, issues.pageInfo.endCursor))]
}

/**
 * Precision over the last 28 days of `qa-agent` tickets: valid / (valid + not-a-bug + env-artifact).
 * Duplicates are counted but move neither precision nor the sample (`labelled`).
 */
export const computeScorecard = async (fetchFn: typeof fetch, key: string): Promise<Scorecard> => {
  const tickets = await scorecardTickets(fetchFn, key)
  const [valid, notABug, duplicate, envArtifact] = triageLabels.map(
    (label) => tickets.filter((ticket) => ticket.labels.nodes.some((l) => l.name === label)).length,
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
    // Linear's message can quote the input back, and a security ticket's text must stay out of the public log.
    { errorDetail: !names.includes(qaLabels.security) },
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
    { errorDetail: true },
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
  if (!response.ok) {
    // Storage answers XML; its <Message> is the reason without the request details echoed around it.
    const body = await response.text()
    throw new Error(`Linear upload HTTP ${response.status}: ${/<Message>([^<]*)/.exec(body)?.[1] ?? body}`)
  }
  return assetUrl
}

/**
 * An error message as one public log line: no URL query string (an upload URL's is its signature), no secret shapes,
 * no link outside Linear's uploads, at most 300 characters.
 */
const logSafe = (message: string) =>
  cleanLogLine(message.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1'))
    .replace(/\s+/g, ' ')
    .slice(0, 300)

// ---------- ticket text ----------

/**
 * Findings of one defect (a group from `verified.json`, or else a fingerprint), filed as one ticket. `v` and `f` are
 * the most severe and give it its text; `fp` is `ticketFingerprint`. `group` starts with that most severe finding.
 */
type Member = { v: VerifiedFinding; f: Finding; fp: string; sev: Severity }
type Entry = Member & {
  /** The group's platforms, in `platforms.json` order. */
  platforms: string[]
  group: Member[]
}

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
  { v, f, sev, platforms, group }: Entry,
  spec: string,
  extra: { runUrl?: string; sha?: string; videoUrl?: string; screenshotUrl?: string; regressionOf?: Existing },
): string => {
  const runUrl = f.area === 'security' ? undefined : extra.runUrl
  const view = ticketView(f, runUrl)
  // The grouping call can be wrong, so a member worded differently keeps its own title and evidence on the ticket.
  const others = group.slice(1).flatMap(({ f: other, fp }) => {
    if (fp === group[0].fp) return []
    const { title, oracle } = ticketView(other, runUrl)
    return [`- ${other.viewport}: ${title} (${oracle.evidence.replace(/\s+/g, ' ')})`]
  })
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
    others.length > 0 && `## Also in this group\n${others.join('\n')}`,
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

/** Runs before grouping, so holding back an Android finding never holds back its iOS twin. */
const refusal = (f: Finding) => {
  if (f.oracle.type === 'visual' && !(f.element?.trim() && f.function?.trim())) {
    return 'visual finding without an element and a function to deduplicate on'
  }
  // Android's probe reports uncovered sidebar buttons as covered; its other layout kinds file normally.
  if (f.viewport === 'android' && f.oracle.type === 'layout' && /\[qa-layout\] covered\s/.test(f.oracle.evidence)) {
    return 'Android covered finding, held back until the probe sweeps correct Android screens clean'
  }
  return undefined
}

/**
 * The fingerprint a group files under: its first finding in `platforms.json` order, then by fingerprint. Nothing is
 * stored across weeks, so the same findings must pick the same `[qa:<fp>]` ticket every week.
 */
const ticketFingerprint = (group: Member[]) =>
  group.toSorted(
    (a, b) => platformIds.indexOf(a.f.viewport) - platformIds.indexOf(b.f.viewport) || a.fp.localeCompare(b.fp),
  )[0].fp

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
    const sev = judgedSeverity(f, proposedSeveritySchema.parse(v.judge?.priority))
    const found = { v, f, fp: fingerprint(v.finding), sev }
    const reason = refusal(f)
    if (!reason) return [found]
    filed.push({ fp: found.fp, severity: found.sev, charterDir: v.charterDir, id: v.id, action: 'refused', reason })
    return []
  })
  // Sorted before grouping, so a group files with the severity of its most severe finding.
  scored.sort((a, b) => priority[a.sev] - priority[b.sev] || a.fp.localeCompare(b.fp))
  const groupOf = new Map(verified.groups?.flatMap((ids, i) => ids.map((id) => [id, i] as const)))
  const entries: Entry[] = [...Map.groupBy(scored, (s) => groupOf.get(findingId(s.v)) ?? s.fp).values()].map(
    (group) => ({
      ...group[0],
      fp: ticketFingerprint(group),
      platforms: platformIds.filter((id) => group.some((s) => s.f.viewport === id)),
      group,
    }),
  )

  const record = ({ group, fp, sev }: Entry, outcome: Omit<Filed, 'fp' | 'severity' | 'charterDir' | 'id'>) =>
    filed.push(...group.map(({ v }) => ({ fp, severity: sev, charterDir: v.charterDir, id: v.id, ...outcome })))
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
  /** A failed upload costs the ticket only that attachment. */
  const attach = async (ctx: Ctx, fp: string, kind: LostAttachment['kind'], path: string, lost: LostAttachment[]) => {
    try {
      return await uploadAsset(ctx, path)
    } catch (error) {
      const reason = logSafe(error instanceof Error ? error.message : String(error))
      lost.push({ kind, reason })
      log(`::warning::${fp}: filing without the ${kind}: ${reason}`)
      return undefined
    }
  }
  /** A ticket that fails is logged and kept for the end, so every other ticket is still tried. */
  const failures: string[] = []
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step()
    } catch (error) {
      const reason = logSafe(error instanceof Error ? error.message : String(error))
      failures.push(`${what}: ${reason}`)
      log(`::error::Linear failed on ${what}: ${reason}`)
    }
  }

  for (const entry of entries) {
    await attempt(entry.fp, async () => {
      const { v, f, fp, sev } = entry
      // The lead's spec and text reach Linear, and the other members' titles and evidence with them.
      const spec = f.repro_spec ? await readFile(join(outDir, v.charterDir, f.repro_spec), 'utf8') : ''
      if ([modelText(f, spec), ...entry.group.map((m) => modelText(m.f, ''))].some((t) => secretPattern.test(t))) {
        record(entry, { action: 'refused', reason: 'secret pattern in model-written text' })
        return
      }
      const decision: Decision = ctx ? await decide(ctx, fp, now) : { kind: 'new' }
      if (decision.kind === 'suppressed') {
        record(entry, { action: 'suppressed', reason: 'a canceled ticket carries this fingerprint' })
        return
      }
      if (decision.kind === 'commented') {
        const link = f.area === 'security' || !runUrl ? '' : `: ${runUrl}`
        const body = `Seen again in a QA run${link}\n\n${platformsLine(entry.platforms)}`
        await act(entry, 'commented', { issue: decision.issue.identifier, body }, async (ctx) => {
          await addComment(ctx, decision.issue.id, body)
          return { issueId: decision.issue.id, identifier: decision.issue.identifier, url: decision.issue.url }
        })
        return
      }
      const regressionOf = decision.kind === 'regression' ? decision.issue : undefined
      const visual = f.oracle.type === 'visual'
      const names = [qaLabels.agent, qaLabels.bug, ...(f.area === 'security' ? [qaLabels.security] : [])]
      const title = `${ticketView(f).title} [qa:${fp}]`
      // A security finding's video and screenshot can show what leaked; they stay in the run artifacts.
      const video = f.area === 'security' ? undefined : v.artifacts.video
      const screenshot = f.area === 'security' || !visual ? undefined : screenshotPath(outDir, v)
      const preview = { title, labels: names, body: buildBody(entry, spec, { runUrl, sha, regressionOf }) }
      await act(entry, regressionOf ? 'regression' : 'created', preview, async (ctx) => {
        const lost: LostAttachment[] = []
        const videoUrl = video ? await attach(ctx, fp, 'video', videoPath(outDir, video), lost) : undefined
        const screenshotUrl = screenshot ? await attach(ctx, fp, 'screenshot', screenshot, lost) : undefined
        const body = buildBody(entry, spec, { runUrl, sha, videoUrl, screenshotUrl, regressionOf })
        const issue = await createIssue(ctx, title, body, sev, names)
        return {
          issueId: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          lostAttachments: lost.length ? lost : undefined,
        }
      })
    })
  }

  await writeFile(join(outDir, 'filed.json'), JSON.stringify(filed, null, 2))
  if (failures.length) throw new Error(`Filing failed for ${failures.length}:\n${failures.join('\n')}`)
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
