#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type NotificationInput = {
  workflowName: string
  runId: number
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
type State = { id: string; name: string; type: string }
type Label = { id: string; name: string; team: { id: string } | null }
type LinearVariables =
  | { teamId: string; title: string }
  | { id: string; stateId: string }
  | { id: string; description: string }
  | { issueId: string; body: string }
  | { input: { teamId: string; title: string; stateId: string; labelIds: string[]; description: string } }

/** Read JSON and surface API failures without printing request credentials. */
const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`)
  return (await response.json()) as T
}

/** Query Linear and reject GraphQL errors, including partial 200 responses. */
const linear = async <T>(
  fetchFn: typeof fetch,
  key: string,
  query: string,
  variables?: LinearVariables,
): Promise<T> => {
  const result = await readJson<{ data?: T; errors?: { message: string }[] }>(
    await fetchFn('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }),
  )
  if (result.errors?.length) throw new Error(`Linear: ${result.errors.map((error) => error.message).join('; ')}`)
  if (!result.data) throw new Error('Linear returned no data')
  return result.data
}

/** Collect failed jobs and steps from all pages of the latest run attempt. */
const failedJobs = async (fetchFn: typeof fetch, input: NotificationInput): Promise<string> => {
  const lines: string[] = []
  for (let page = 1; ; page++) {
    const response = await readJson<{ jobs: Job[] }>(
      await fetchFn(
        `https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}/jobs?filter=latest&per_page=100&page=${page}`,
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
  recipients: string[] = input.recipients,
): Promise<void> => {
  await readJson<{ id: string }>(
    await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.resendApiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from: 'alerts@auth.thunderbolt.io', to: recipients, subject, text: message }),
    }),
  )
}

const pendingMarker = '\n\nCI alert email pending for: '

/** Recover the original failure email payload and recipients from an open incident. */
const pendingEmail = (description: string): { body: string; recipients: string[] } | null => {
  const markerAt = description.lastIndexOf(pendingMarker)
  if (markerAt < 0) return null
  const recipients = description
    .slice(markerAt + pendingMarker.length)
    .split(',')
    .filter(Boolean)
  if (!recipients.length) throw new Error('Pending incident has no alert recipients')
  return { body: description.slice(0, markerAt), recipients }
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

  /** Complete a previously created incident's first email before further transitions. */
  const finishOpeningEmail = async (issue: Incident): Promise<void> => {
    const pending = pendingEmail(issue.description ?? '')
    if (!pending) return
    if (input.dryRun) return log(`Dry run: would send pending opening email for ${issue.url}`)
    await sendEmail(
      fetchFn,
      input,
      title,
      `${pending.body}\nIncident: ${issue.url}`,
      `ci-failure/${issue.id}`,
      pending.recipients,
    )
    const marked = await linear<{ issueUpdate: { success: boolean } }>(
      fetchFn,
      input.linearApiKey,
      'mutation MarkFailureEmailSent($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }',
      { id: issue.id, description: pending.body },
    )
    if (!marked.issueUpdate.success) throw new Error('Linear did not mark the failure email delivered')
  }

  if (incident) await finishOpeningEmail(incident)

  if (input.conclusion === 'success') {
    if (!incident) return log(`No open incident for ${input.workflowName}; nothing to recover`)
    const done = data.workflowStates.nodes.find((state) => state.type === 'completed')
    if (!done) throw new Error('Completed Linear state not found')
    if (input.dryRun) return log(`Dry run: would close ${incident.url} and email recovery for ${runUrl}`)
    await sendEmail(
      fetchFn,
      input,
      `CI recovered: ${input.workflowName}`,
      `${input.workflowName} recovered.\nIncident: ${incident.url}`,
      `ci-recovery/${incident.id}`,
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
  const pendingDescription = `${body}${pendingMarker}${input.recipients.join(',')}`
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
