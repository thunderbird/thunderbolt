#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type NotificationInput = {
  workflowName: string
  runId: number
  runAttempt: number
  conclusion: string
  eventName: string
  ref: string
  repository: string
  githubToken: string
  linearApiKey: string
  resendApiKey: string
  recipients: string[]
  dryRun?: boolean
}

type Job = {
  name: string
  conclusion: string | null
  html_url: string
  steps?: { name: string; conclusion: string | null }[]
}
type Incident = { id: string; url: string; description: string | null }
type RunOrder = { createdAt: number; runId: number; attempt: number; workflowId: number }
type AlertState = {
  version: 1
  repository: string
  workflowName: string
  latestFailure: RunOrder
  pendingOpening: boolean
  openingRecipientsHash: string
  recoveryRecipientsHash?: string
}
type State = { id: string; name: string; type: string }
type Label = { id: string; name: string; team: { id: string } | null }
type LinearVariables =
  | { teamId: string; title: string }
  | { id: string; stateId: string }
  | { id: string; description: string }
  | { issueId: string; body: string }
  | { input: { teamId: string; title: string; stateId: string; labelIds: string[]; description: string } }

/** Report only trusted API context, never response content or network error text. */
const requestJson = async <T>(
  service: string,
  operation: string,
  request: () => Promise<Response>,
): Promise<{ body: T; status: number }> => {
  const context = `${service} ${operation}`
  const response = await request().catch(() => {
    throw new Error(`${context} request failed`)
  })
  if (!response.ok) throw new Error(`${context} HTTP ${response.status}`)
  const body = (await response.json().catch(() => {
    throw new Error(`${context} HTTP ${response.status} invalid JSON`)
  })) as T
  return { body, status: response.status }
}

/** Query Linear and reject GraphQL errors, including partial 200 responses. */
const linear = async <T>(
  fetchFn: typeof fetch,
  key: string,
  query: string,
  variables?: LinearVariables,
): Promise<T> => {
  const operation = /^(?:query|mutation) (\w+)/.exec(query)?.[1] ?? 'GraphQL'
  const { body: result, status } = await requestJson<{ data?: T; errors?: { message: string }[] }>(
    'Linear',
    operation,
    () =>
      fetchFn('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      }),
  )
  if (result.errors?.length) throw new Error(`Linear ${operation} HTTP ${status} GraphQL errors`)
  if (!result.data) throw new Error(`Linear ${operation} HTTP ${status} returned no data`)
  return result.data
}

/** Collect failed jobs and steps from the exact run attempt. */
const failedJobs = async (fetchFn: typeof fetch, input: NotificationInput): Promise<string> => {
  const lines: string[] = []
  for (let page = 1; ; page++) {
    const { body: response } = await requestJson<{ jobs: Job[] }>('GitHub', 'list jobs', () =>
      fetchFn(
        `https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${input.githubToken}`, Accept: 'application/vnd.github+json' } },
      ),
    )
    for (const job of response.jobs) {
      if (job.conclusion !== 'failure' && job.conclusion !== 'timed_out') continue
      const steps = job.steps?.filter((step) => step.conclusion === 'failure' || step.conclusion === 'timed_out') ?? []
      lines.push(
        `- ${job.name}: ${job.html_url}${steps.length ? `\n${steps.map((step) => `  - ${step.name}`).join('\n')}` : ''}`,
      )
    }
    if (response.jobs.length < 100) return lines.join('\n') || '- No failed jobs reported by GitHub.'
  }
}

/** Send a plain-text incident alert through Resend. */
const sendEmail = async (
  fetchFn: typeof fetch,
  input: NotificationInput,
  subject: string,
  message: string,
  idempotencyKey: string,
): Promise<void> => {
  await requestJson<{ id: string }>('Resend', 'send email', () =>
    fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from: 'alerts@auth.thunderbolt.io', to: input.recipients, subject, text: message }),
    }),
  )
}

const stateMarker = '\n\nCI notifier state: '

/** Bind editable incident state to the existing server-side Linear secret. */
const signedDescription = (body: string, state: AlertState, key: string): string => {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url')
  const signature = createHmac('sha256', key).update(`${body}\n${payload}`).digest('base64url')
  return `${body}${stateMarker}${payload}.${signature}`
}

/** Parse authenticated state without exposing its contents in errors. */
const parseState = (payload: string): AlertState => {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AlertState
  } catch {
    throw new Error('Invalid incident state; manual repair required')
  }
}

/** Reject missing, edited, or legacy state before it can authorize side effects. */
const readState = (issue: Incident, input: NotificationInput) => {
  const description = issue.description ?? ''
  const markerAt = description.lastIndexOf(stateMarker)
  const match =
    markerAt < 0 ? null : /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(description.slice(markerAt + stateMarker.length))
  if (!match) throw new Error('Invalid incident state; manual repair required')
  const body = description.slice(0, markerAt)
  const expected = createHmac('sha256', input.linearApiKey).update(`${body}\n${match[1]}`).digest()
  const actual = Buffer.from(match[2], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid incident state; manual repair required')
  }
  const state = parseState(match[1])
  if (
    !state ||
    state.version !== 1 ||
    state.repository !== input.repository ||
    state.workflowName !== input.workflowName
  ) {
    throw new Error('Invalid incident state; manual repair required')
  }
  return { body, state }
}

/** Fingerprint recipients without saving addresses or a guessable hash in Linear. */
const recipientsHash = (input: NotificationInput): string =>
  createHmac('sha256', input.linearApiKey).update(JSON.stringify(input.recipients)).digest('base64url')

/** Read ordering and verify the run really belongs to the trusted workflow. */
const runOrder = async (fetchFn: typeof fetch, input: NotificationInput): Promise<RunOrder> => {
  const { body: run } = await requestJson<{
    id: number
    name: string
    event: string
    head_branch: string
    repository: { full_name: string }
    created_at: string
    run_attempt: number
    workflow_id: number
  }>('GitHub', 'get run', () =>
    fetchFn(`https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}`, {
      headers: { Authorization: `Bearer ${input.githubToken}`, Accept: 'application/vnd.github+json' },
    }),
  )
  const createdAt = Date.parse(run.created_at)
  if (
    run.id !== input.runId ||
    run.name !== input.workflowName ||
    run.event !== input.eventName ||
    run.head_branch !== 'main' ||
    run.repository?.full_name !== input.repository ||
    !Number.isFinite(createdAt) ||
    !Number.isSafeInteger(run.workflow_id) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < input.runAttempt
  )
    throw new Error('GitHub run identity mismatch')
  return { createdAt, runId: input.runId, attempt: input.runAttempt, workflowId: run.workflow_id }
}

/** Compare run creation, run ID, then attempt for reruns of one run. */
const compareRuns = (a: RunOrder, b: RunOrder): number => {
  if (a.workflowId !== b.workflowId) throw new Error('GitHub workflow identity mismatch')
  return a.createdAt - b.createdAt || a.runId - b.runId || a.attempt - b.attempt
}

/** Check GitHub history so replaying an older signed marker cannot hide a newer failure. */
const hasNewerFailure = async (
  fetchFn: typeof fetch,
  input: NotificationInput,
  currentRun: RunOrder,
): Promise<boolean> => {
  const created = new Date(currentRun.createdAt).toISOString().slice(0, 19) + 'Z'
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      branch: 'main',
      status: 'completed',
      created: `>=${created}`,
      per_page: '100',
      page: String(page),
    })
    const { body: history } = await requestJson<{
      workflow_runs: {
        id: number
        created_at: string
        run_attempt: number
        conclusion: string | null
        event: string
        head_branch: string
        repository: { full_name: string }
      }[]
    }>('GitHub', 'list workflow runs', () =>
      fetchFn(
        `https://api.github.com/repos/${input.repository}/actions/workflows/${currentRun.workflowId}/runs?${query}`,
        {
          headers: { Authorization: `Bearer ${input.githubToken}`, Accept: 'application/vnd.github+json' },
        },
      ),
    )
    for (const run of history.workflow_runs) {
      if (!['schedule', 'push', 'workflow_dispatch'].includes(run.event) || run.head_branch !== 'main') continue
      if (run.repository?.full_name !== input.repository) throw new Error('GitHub workflow run history mismatch')
      const createdAt = Date.parse(run.created_at)
      if (!Number.isFinite(createdAt) || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) {
        throw new Error('Invalid GitHub workflow run history')
      }
      if (
        (run.conclusion === 'failure' || run.conclusion === 'timed_out') &&
        compareRuns(
          { createdAt, runId: run.id, attempt: run.run_attempt, workflowId: currentRun.workflowId },
          currentRun,
        ) > 0
      )
        return true
    }
    if (history.workflow_runs.length < 100) return false
  }
  throw new Error('GitHub workflow run history exceeded safe pagination limit')
}

/** Handle a completed trusted workflow run, with read-only dry-run support. */
export const notify = async (
  input: NotificationInput,
  fetchFn: typeof fetch = fetch,
  log: (line: string) => void = console.log,
): Promise<void> => {
  if (!['schedule', 'push', 'workflow_dispatch'].includes(input.eventName) || input.ref !== 'refs/heads/main') {
    throw new Error('Untrusted event: refusing notification before any fetch')
  }
  if (input.conclusion !== 'failure' && input.conclusion !== 'success') {
    log(`Ignoring ${input.conclusion} workflow conclusion`)
    return
  }
  if (!input.recipients.length) throw new Error('No alert recipients configured')
  if (
    !Number.isSafeInteger(input.runId) ||
    input.runId <= 0 ||
    !Number.isSafeInteger(input.runAttempt) ||
    input.runAttempt <= 0 ||
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !input.workflowName.trim()
  ) {
    throw new Error('Invalid workflow run identity')
  }
  const runUrl = `https://github.com/${input.repository}/actions/runs/${input.runId}`
  const title = `CI failing: ${input.workflowName}`

  const teams = await linear<{ teams: { nodes: { id: string; name: string }[] } }>(
    fetchFn,
    input.linearApiKey,
    'query Teams { teams(first: 100) { nodes { id name } } }',
  )
  const teamId = teams.teams.nodes.find((team) => team.name === 'Thunderbolt')?.id
  if (!teamId) throw new Error('Thunderbolt team not found')

  const data = await linear<{
    issues: { nodes: Incident[] }
    workflowStates: { nodes: State[] }
    issueLabels: { nodes: Label[] }
  }>(
    fetchFn,
    input.linearApiKey,
    `query Incident($teamId: String!, $title: String!) {
    issues(first: 2, filter: { team: { id: { eq: $teamId } }, title: { eq: $title }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id url description } }
    workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } }
    issueLabels(first: 100, filter: { name: { eq: "Bug" } }) { nodes { id name team { id } } }
  }`,
    { teamId, title },
  )
  if (data.issues.nodes.length > 1) throw new Error(`Multiple open incidents for ${title}`)
  const incident = data.issues.nodes[0]
  if (input.conclusion === 'success' && !incident) {
    return log(`No open incident for ${input.workflowName}; nothing to recover`)
  }
  const currentRun = await runOrder(fetchFn, input)

  /** Persist authenticated state before any email whose retry must be stable. */
  const updateState = async (issue: Incident, body: string, state: AlertState, mutationName: string): Promise<void> => {
    const description = signedDescription(body, state, input.linearApiKey)
    const updated = await linear<{ issueUpdate: { success: boolean } }>(
      fetchFn,
      input.linearApiKey,
      `mutation ${mutationName}($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }`,
      { id: issue.id, description },
    )
    if (!updated.issueUpdate.success) throw new Error('Linear did not update incident state')
    issue.description = description
  }

  /** Complete a previously created incident's first email before further transitions. */
  const finishOpeningEmail = async (issue: Incident): Promise<void> => {
    const { body, state } = readState(issue, input)
    if (!state.pendingOpening) return
    if (state.openingRecipientsHash !== recipientsHash(input)) {
      throw new Error(
        'Alert recipients changed while opening email is pending; restore prior configuration before retry',
      )
    }
    if (input.dryRun) return log(`Dry run: would send pending opening email for ${issue.url}`)
    await sendEmail(fetchFn, input, title, `${body}\nIncident: ${issue.url}`, `ci-failure/${issue.id}`)
    await updateState(issue, body, { ...state, pendingOpening: false }, 'MarkFailureEmailSent')
  }

  if (incident) await finishOpeningEmail(incident)

  if (input.conclusion === 'success' && incident) {
    const { body: incidentBody, state } = readState(incident, input)
    if (compareRuns(currentRun, state.latestFailure) <= 0 || (await hasNewerFailure(fetchFn, input, currentRun))) {
      return log(`Ignoring recovery older than latest failure for ${incident.url}`)
    }
    const done = data.workflowStates.nodes.find((state) => state.type === 'completed')
    if (!done) throw new Error('Completed Linear state not found')
    if (input.dryRun) return log(`Dry run: would close ${incident.url} and email recovery for ${runUrl}`)
    const currentRecipientsHash = recipientsHash(input)
    if (state.recoveryRecipientsHash && state.recoveryRecipientsHash !== currentRecipientsHash) {
      throw new Error(
        'Alert recipients changed while recovery email is pending; restore prior configuration before retry',
      )
    }
    if (!state.recoveryRecipientsHash) {
      await updateState(
        incident,
        incidentBody,
        { ...state, recoveryRecipientsHash: currentRecipientsHash },
        'MarkRecoveryPending',
      )
    }
    await sendEmail(
      fetchFn,
      input,
      `CI recovered: ${input.workflowName}`,
      `${input.workflowName} recovered.\nIncident: ${incident.url}`,
      `ci-recovery/${incident.id}/${state.latestFailure.runId}/${state.latestFailure.attempt}`,
    )
    const closed = await linear<{ issueUpdate: { success: boolean } }>(
      fetchFn,
      input.linearApiKey,
      'mutation CloseIssue($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: incident.id, stateId: done.id },
    )
    if (!closed.issueUpdate.success) throw new Error('Linear did not close the incident')
    return log(`Closed ${incident.url} and sent recovery email`)
  }

  const failures = await failedJobs(fetchFn, input)
  const body = `Workflow: ${input.workflowName}\nRun: ${runUrl}\nFailed jobs and steps:\n${failures}`
  if (incident) {
    if (input.dryRun) return log(`Dry run: would comment on ${incident.url}\n${body}`)
    const { body: incidentBody, state } = readState(incident, input)
    const order = compareRuns(currentRun, state.latestFailure)
    if (order < 0) {
      return log(`Ignoring failure older than latest failure for ${incident.url}`)
    }
    if (order > 0) {
      await updateState(
        incident,
        incidentBody,
        { ...state, latestFailure: currentRun, recoveryRecipientsHash: undefined },
        'MarkLatestFailure',
      )
    } else if (state.recoveryRecipientsHash) {
      return log(`Ignoring duplicate failure during recovery for ${incident.url}`)
    }
    const commented = await linear<{ commentCreate: { success: boolean } }>(
      fetchFn,
      input.linearApiKey,
      'mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
      { issueId: incident.id, body },
    )
    if (!commented.commentCreate.success) throw new Error('Linear did not add the failure comment')
    return log(`Commented on ${incident.url}`)
  }

  const backlog = data.workflowStates.nodes.find((state) => state.name === 'Backlog' && state.type === 'backlog')
  const bug = data.issueLabels.nodes.find((label) => label.name === 'Bug' && (label.team?.id === teamId || !label.team))
  if (!backlog || !bug) throw new Error('Backlog state or Bug label not found')
  if (input.dryRun)
    return log(
      `Dry run: would create ${title} in Backlog with Bug label and email ${input.recipients.length} recipients\n${body}`,
    )
  const pendingDescription = signedDescription(
    body,
    {
      version: 1,
      repository: input.repository,
      workflowName: input.workflowName,
      latestFailure: currentRun,
      pendingOpening: true,
      openingRecipientsHash: recipientsHash(input),
    },
    input.linearApiKey,
  )
  const created = await linear<{ issueCreate: { success: boolean; issue: Incident } }>(
    fetchFn,
    input.linearApiKey,
    'mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id url } } }',
    {
      input: {
        teamId,
        title,
        stateId: backlog.id,
        labelIds: [bug.id],
        description: pendingDescription,
      },
    },
  )
  if (!created.issueCreate.success) throw new Error('Linear did not create the incident')
  await finishOpeningEmail({ ...created.issueCreate.issue, description: pendingDescription })
  log(`Created ${created.issueCreate.issue.url} and sent failure email`)
}

if (import.meta.main) {
  const env = Bun.env
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`Missing ${name}`)
    return value
  }
  await notify({
    workflowName: required('WORKFLOW_NAME'),
    runId: Number(required('WORKFLOW_RUN_ID')),
    runAttempt: Number(required('GITHUB_RUN_ATTEMPT')),
    conclusion: required('WORKFLOW_CONCLUSION'),
    eventName: required('GITHUB_EVENT_NAME'),
    ref: required('GITHUB_REF'),
    repository: required('GITHUB_REPOSITORY'),
    githubToken: required('GITHUB_TOKEN'),
    linearApiKey: required('LINEAR_API_KEY'),
    resendApiKey: required('RESEND_API_KEY'),
    recipients: required('ALERT_RECIPIENTS')
      .split(',')
      .map((email) => email.trim())
      .filter(Boolean),
    dryRun: Bun.argv.includes('--dry-run'),
  })
}
