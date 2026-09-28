/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { notify, type NotificationInput } from './notify-on-failure'

const input: NotificationInput = {
  workflowName: 'CI',
  runId: 42,
  runAttempt: 1,
  conclusion: 'failure',
  eventName: 'push',
  ref: 'refs/heads/main',
  repository: 'thunderbird/thunderbolt',
  githubToken: 'github-token',
  linearApiKey: 'linear-token',
  resendApiKey: 'resend-token',
  recipients: ['alerts@example.com'],
}

type Call = { url: string; body: string; idempotencyKey: string | null }
type FakeState = {
  created: boolean
  description: string | null
  failEmailCount: number
  failMarkCount: number
  failCloseCount?: number
  githubRunAttempt?: number
  failedRuns?: number[]
}

const fakeFetch = (existingIssue: boolean, calls: Call[], state?: FakeState): typeof fetch =>
  (async (request, init) => {
    const url = String(request)
    const body = String(init?.body ?? '')
    calls.push({ url, body, idempotencyKey: new Headers(init?.headers).get('Idempotency-Key') })
    if (/\/actions\/runs\/\d+$/.test(url)) {
      const runId = Number(url.match(/\/runs\/(\d+)$/)?.[1])
      return Response.json({
        id: runId,
        name: input.workflowName,
        event: input.eventName,
        head_branch: 'main',
        repository: { full_name: input.repository },
        created_at: new Date(2026, 0, runId).toISOString(),
        run_attempt: state?.githubRunAttempt ?? 1,
        workflow_id: 7,
      })
    }
    if (url.includes('/actions/workflows/')) {
      return Response.json({
        workflow_runs: (state?.failedRuns ?? []).map((runId) => ({
          id: runId,
          created_at: new Date(2026, 0, runId).toISOString(),
          run_attempt: state?.githubRunAttempt ?? 1,
          conclusion: 'failure',
          event: input.eventName,
          head_branch: 'main',
          repository: { full_name: input.repository },
        })),
      })
    }
    if (url.includes('/actions/runs/'))
      return Response.json({
        jobs: [
          {
            name: 'typescript',
            conclusion: 'failure',
            html_url: 'https://github.com/job/1',
            steps: [{ name: 'Check types', conclusion: 'failure' }],
          },
        ],
      })
    if (url === 'https://api.resend.com/emails') {
      if (state?.failEmailCount) {
        state.failEmailCount--
        return Response.json({ error: 'temporary failure' }, { status: 503 })
      }
      return Response.json({ id: 'email-id' })
    }
    if (body.includes('query Teams'))
      return Response.json({ data: { teams: { nodes: [{ id: 'team-id', name: 'Thunderbolt' }] } } })
    if (body.includes('query Incident'))
      return Response.json({
        data: {
          issues: {
            nodes:
              existingIssue || state?.created
                ? [{ id: 'issue-id', url: 'https://linear.app/issue/1', description: state ? state.description : '' }]
                : [],
          },
          workflowStates: {
            nodes: [
              { id: 'backlog-id', name: 'Backlog', type: 'backlog' },
              { id: 'done-id', name: 'Done', type: 'completed' },
            ],
          },
          issueLabels: { nodes: [{ id: 'bug-id', name: 'Bug', team: null }] },
        },
      })
    if (body.includes('mutation CreateIssue')) {
      if (state) {
        const requestBody = JSON.parse(body) as { variables: { input: { description: string } } }
        state.created = true
        state.description = requestBody.variables.input.description
      }
      return Response.json({
        data: { issueCreate: { success: true, issue: { id: 'issue-id', url: 'https://linear.app/issue/1' } } },
      })
    }
    if (
      body.includes('mutation MarkFailureEmailSent') ||
      body.includes('mutation MarkLatestFailure') ||
      body.includes('mutation MarkRecoveryPending')
    ) {
      if (body.includes('mutation MarkFailureEmailSent') && state?.failMarkCount) {
        state.failMarkCount--
        return Response.json({ errors: [{ message: 'Linear update failed' }] })
      }
      if (state) state.description = (JSON.parse(body) as { variables: { description: string } }).variables.description
      return Response.json({ data: { issueUpdate: { success: true } } })
    }
    if (body.includes('mutation Comment')) return Response.json({ data: { commentCreate: { success: true } } })
    if (body.includes('mutation CloseIssue')) {
      if (state?.failCloseCount) {
        state.failCloseCount--
        return Response.json({ errors: [{ message: 'Close failed' }] })
      }
      if (state) state.created = false
      return Response.json({ data: { issueUpdate: { success: true } } })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

const seededIssue = async (state: FakeState, calls: Call[]) => {
  const fetchFn = fakeFetch(false, calls, state)
  await notify(input, fetchFn)
  calls.length = 0
  return fetchFn
}

const incidentState = (description: string | null) => {
  const payload = description?.split('CI notifier state: ')[1]?.split('.')[0]
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { pendingOpening: boolean }
}

describe('notify-on-failure', () => {
  test('first failure creates one Backlog Bug incident and sends an email with failed jobs and steps', async () => {
    const calls: Call[] = []
    await notify(input, fakeFetch(false, calls))
    const create = calls.find((call) => call.body.includes('mutation CreateIssue'))?.body
    expect(create).toContain('"title":"CI failing: CI"')
    expect(create).toContain('"stateId":"backlog-id"')
    expect(create).toContain('"labelIds":["bug-id"]')
    expect(create).toContain('Check types')
    expect(calls.filter((call) => call.url === 'https://api.resend.com/emails')).toHaveLength(1)
  })

  test('a failed job on the second GitHub page appears in the incident and email', async () => {
    const calls: Call[] = []
    const baseFetch = fakeFetch(false, calls)
    const fetchFn: typeof fetch = (async (request, init) => {
      const url = String(request)
      if (url.includes('/attempts/1/jobs?')) {
        calls.push({ url, body: '', idempotencyKey: null })
        return Response.json({
          jobs: url.endsWith('page=1')
            ? Array.from({ length: 100 }, (_, index) => ({
                name: `passing-${index}`,
                conclusion: 'success',
                html_url: `https://github.com/job/${index}`,
              }))
            : [{ name: 'page-two-failure', conclusion: 'failure', html_url: 'https://github.com/job/101' }],
        })
      }
      return baseFetch(request, init)
    }) as typeof fetch

    await notify(input, fetchFn)
    const create = calls.find((call) => call.body.includes('mutation CreateIssue'))?.body
    const email = calls.find((call) => call.url === 'https://api.resend.com/emails')?.body
    expect(calls.filter((call) => call.url.includes('/attempts/1/jobs?'))).toHaveLength(2)
    expect(create).toContain('page-two-failure')
    expect(email).toContain('page-two-failure')
    expect(create).not.toContain('passing-0')
  })

  test('timed out jobs and steps appear in the failure alert', async () => {
    const calls: Call[] = []
    const baseFetch = fakeFetch(false, calls)
    const fetchFn: typeof fetch = (async (request, init) => {
      const url = String(request)
      if (url.includes('/attempts/1/jobs?')) {
        calls.push({ url, body: '', idempotencyKey: null })
        return Response.json({
          jobs: [
            {
              name: 'timed-out-job',
              conclusion: 'timed_out',
              html_url: 'https://github.com/job/timeout',
              steps: [{ name: 'slow step', conclusion: 'timed_out' }],
            },
            {
              name: 'failed-job',
              conclusion: 'failure',
              html_url: 'https://github.com/job/failed',
              steps: [{ name: 'failed step', conclusion: 'failure' }],
            },
          ],
        })
      }
      return baseFetch(request, init)
    }) as typeof fetch

    await notify(input, fetchFn)
    const email = calls.find((call) => call.url === 'https://api.resend.com/emails')?.body
    expect(email).toContain('timed-out-job')
    expect(email).toContain('slow step')
    expect(email).toContain('failed-job')
    expect(email).toContain('failed step')
  })

  test('repeat failure adds a comment without another email', async () => {
    const calls: Call[] = []
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const fetchFn = await seededIssue(state, calls)
    await notify({ ...input, runId: 43 }, fetchFn)
    expect(calls.some((call) => call.body.includes('mutation Comment'))).toBe(true)
    expect(calls.some((call) => call.body.includes('mutation CreateIssue'))).toBe(false)
    expect(calls.some((call) => call.url === 'https://api.resend.com/emails')).toBe(false)
  })

  test('recovery closes an open incident and sends an email', async () => {
    const calls: Call[] = []
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const fetchFn = await seededIssue(state, calls)
    await notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)
    expect(calls.find((call) => call.body.includes('mutation CloseIssue'))?.body).toContain('"stateId":"done-id"')
    expect(calls.filter((call) => call.url === 'https://api.resend.com/emails')).toHaveLength(1)
    expect(calls.some((call) => call.url.endsWith('/actions/runs/43'))).toBe(true)
  })

  test('success without an open incident makes no writes', async () => {
    const calls: Call[] = []
    await notify({ ...input, conclusion: 'success' }, fakeFetch(false, calls))
    expect(calls.some((call) => call.body.includes('mutation') || call.url === 'https://api.resend.com/emails')).toBe(
      false,
    )
  })

  test('PR event is refused before any fetch', async () => {
    const calls: Call[] = []
    await expect(notify({ ...input, eventName: 'pull_request' }, fakeFetch(false, calls))).rejects.toThrow(
      'Untrusted event',
    )
    expect(calls).toHaveLength(0)
  })

  test('dry run makes no writes', async () => {
    const calls: Call[] = []
    const lines: string[] = []
    await notify({ ...input, dryRun: true }, fakeFetch(false, calls), (line) => lines.push(line))
    expect(calls.some((call) => call.body.includes('mutation') || call.url === 'https://api.resend.com/emails')).toBe(
      false,
    )
    expect(lines.join('\n')).toContain('would create')
  })

  test('dry run with an existing incident would comment without writes', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    const lines: string[] = []

    await notify({ ...input, runId: 43, dryRun: true }, fetchFn, (line) => lines.push(line))
    expect(lines.join('\n')).toContain('would comment')
    expect(calls.some((call) => call.url === 'https://api.resend.com/emails' || call.body.includes('mutation'))).toBe(
      false,
    )
    expect(calls.some((call) => call.body.includes('query Incident'))).toBe(true)
  })

  test('dry run with an existing incident would recover without writes', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    const lines: string[] = []

    await notify({ ...input, conclusion: 'success', runId: 43, dryRun: true }, fetchFn, (line) => lines.push(line))
    expect(lines.join('\n')).toContain('would close')
    expect(state.created).toBe(true)
    expect(calls.some((call) => call.url === 'https://api.resend.com/emails' || call.body.includes('mutation'))).toBe(
      false,
    )
    expect(calls.some((call) => call.url.includes('/actions/workflows/'))).toBe(true)
  })

  test('dry run with a pending opening email would report it without writes', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    calls.length = 0
    const lines: string[] = []

    await notify({ ...input, runId: 43, dryRun: true }, fetchFn, (line) => lines.push(line))
    expect(lines.join('\n')).toContain('would send pending opening email')
    expect(lines.join('\n')).toContain('would comment')
    expect(incidentState(state.description).pendingOpening).toBe(true)
    expect(calls.some((call) => call.url === 'https://api.resend.com/emails' || call.body.includes('mutation'))).toBe(
      false,
    )
  })

  test('skipped or cancelled runs do nothing', async () => {
    const calls: Call[] = []
    await notify({ ...input, conclusion: 'cancelled' }, fakeFetch(false, calls))
    await notify({ ...input, conclusion: 'skipped' }, fakeFetch(false, calls))
    expect(calls).toHaveLength(0)
  })

  test('Linear query errors stop before incident creation or email', async () => {
    const calls: Call[] = []
    const baseFetch = fakeFetch(false, calls)
    const fetchFn: typeof fetch = (async (request, init) => {
      if (String(init?.body ?? '').includes('query Incident')) {
        calls.push({ url: String(request), body: String(init?.body), idempotencyKey: null })
        return Response.json({ data: null, errors: [{ message: 'Query failed' }] })
      }
      return baseFetch(request, init)
    }) as typeof fetch
    await expect(notify(input, fetchFn)).rejects.toThrow('Linear Incident HTTP 200 GraphQL errors')
    expect(calls.some((call) => call.body.includes('mutation') || call.url === 'https://api.resend.com/emails')).toBe(
      false,
    )
  })

  test('Linear HTTP and GraphQL errors identify the operation without exposing API messages', async () => {
    const secret = 'PRIVATE_MARKER_3981'
    const baseFetch = fakeFetch(false, [])
    for (const response of [
      Response.json({ errors: [{ message: secret }] }, { status: 400 }),
      Response.json({ errors: [{ message: secret }] }),
      new Response(secret, { status: 502 }),
    ]) {
      const fetchFn: typeof fetch = (async (request, init) =>
        String(init?.body ?? '').includes('query Incident') ? response : baseFetch(request, init)) as typeof fetch
      const error = await notify(input, fetchFn).catch((caught: Error) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Linear Incident')
      expect((error as Error).message).not.toContain(secret)
      expect((error as Error).message).toContain(`HTTP ${response.status}`)
      if (response.status === 200) expect((error as Error).message).toContain('GraphQL errors')
    }
  })

  test('GitHub and Resend failures identify service, operation and status without response data', async () => {
    const secret = 'PRIVATE_MARKER_7729'
    for (const [target, operation] of [
      ['/attempts/1/jobs?', 'GitHub list jobs'],
      ['https://api.resend.com/emails', 'Resend send email'],
    ]) {
      const baseFetch = fakeFetch(false, [])
      const fetchFn: typeof fetch = (async (request, init) =>
        String(request).includes(target)
          ? Response.json({ message: secret, token: secret }, { status: 403 })
          : baseFetch(request, init)) as typeof fetch
      const error = await notify(input, fetchFn).catch((caught: Error) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(`${operation} HTTP 403`)
      expect((error as Error).message).not.toContain(secret)
    }
  })

  test('malformed API JSON and network errors do not expose raw details', async () => {
    const secret = 'PRIVATE_MARKER_8126'
    const baseFetch = fakeFetch(false, [])
    const malformedFetch: typeof fetch = (async (request, init) =>
      String(init?.body ?? '').includes('query Teams')
        ? new Response(secret, { status: 200 })
        : baseFetch(request, init)) as typeof fetch
    const malformedError = await notify(input, malformedFetch).catch((caught: Error) => caught)
    expect((malformedError as Error).message).toBe('Linear Teams HTTP 200 invalid JSON')
    expect((malformedError as Error).message).not.toContain(secret)

    const networkFetch: typeof fetch = (async (request, init) => {
      if (String(request).includes('/actions/runs/')) throw new Error(secret)
      return baseFetch(request, init)
    }) as typeof fetch
    const networkError = await notify(input, networkFetch).catch((caught: Error) => caught)
    expect((networkError as Error).message).toBe('GitHub get run request failed')
    expect((networkError as Error).message).not.toContain(secret)
  })

  test('a failed issue create does not send an email that would be repeated on retry', async () => {
    const calls: Call[] = []
    const baseFetch = fakeFetch(false, calls)
    const fetchFn: typeof fetch = (async (request, init) => {
      if (String(init?.body ?? '').includes('mutation CreateIssue')) {
        calls.push({ url: String(request), body: String(init?.body), idempotencyKey: null })
        return Response.json({ errors: [{ message: 'Creation failed' }] })
      }
      return baseFetch(request, init)
    }) as typeof fetch
    await expect(notify(input, fetchFn)).rejects.toThrow('Linear CreateIssue HTTP 200 GraphQL errors')
    expect(calls.some((call) => call.url === 'https://api.resend.com/emails')).toBe(false)
  })

  test('PR target and branch dispatch are refused before any fetch', async () => {
    const calls: Call[] = []
    await expect(notify({ ...input, eventName: 'pull_request_target' }, fakeFetch(false, calls))).rejects.toThrow(
      'Untrusted event',
    )
    await expect(
      notify({ ...input, eventName: 'workflow_dispatch', ref: 'refs/heads/feature' }, fakeFetch(false, calls)),
    ).rejects.toThrow('Untrusted event')
    expect(calls).toHaveLength(0)
  })

  test('empty recipients fail before incident creation', async () => {
    const calls: Call[] = []
    await expect(notify({ ...input, recipients: [] }, fakeFetch(false, calls))).rejects.toThrow('No alert recipients')
    expect(calls).toHaveLength(0)
  })

  test('failed opening email retries the original payload from a later run before commenting', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    expect(incidentState(state.description).pendingOpening).toBe(true)
    await notify({ ...input, runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
    expect(emails[0].body).toContain('/actions/runs/42')
    expect(incidentState(state.description).pendingOpening).toBe(false)
    expect(calls.filter((call) => call.body.includes('mutation CreateIssue'))).toHaveLength(1)
    expect(calls.filter((call) => call.body.includes('mutation Comment'))).toHaveLength(1)
  })

  test('recovery completes a pending opening email before closing the incident', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    expect(incidentState(state.description).pendingOpening).toBe(true)

    await notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)

    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(3)
    expect(emails[0].body).toBe(emails[1].body)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[2].idempotencyKey).not.toBe(emails[1].idempotencyKey)
    expect(incidentState(state.description).pendingOpening).toBe(false)
    expect(state.created).toBe(false)
    const mark = calls.findIndex((call) => call.body.includes('mutation MarkFailureEmailSent'))
    const recovery = calls.findIndex((call) => call.idempotencyKey?.startsWith('ci-recovery/'))
    const close = calls.findIndex((call) => call.body.includes('mutation CloseIssue'))
    expect(mark).toBeLessThan(recovery)
    expect(recovery).toBeLessThan(close)
  })

  test('successful email with failed Linear update retries idempotently', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 1 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('Linear MarkFailureEmailSent HTTP 200 GraphQL errors')
    await notify({ ...input, runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
    expect(incidentState(state.description).pendingOpening).toBe(false)
  })

  test('failed recovery email keeps the incident open for a stable retry', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    state.failEmailCount = 1
    await expect(notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)).rejects.toThrow('HTTP 503')
    expect(calls.some((call) => call.body.includes('mutation CloseIssue'))).toBe(false)
    await notify({ ...input, conclusion: 'success', runId: 44 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
    expect(calls.filter((call) => call.body.includes('mutation CloseIssue'))).toHaveLength(1)
  })

  test('accepted recovery email with failed close retries the same payload and key', async () => {
    const state: FakeState = {
      created: false,
      description: '',
      failEmailCount: 0,
      failMarkCount: 0,
      failCloseCount: 0,
    }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    state.failCloseCount = 1
    await expect(notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)).rejects.toThrow(
      'Linear CloseIssue HTTP 200 GraphQL errors',
    )
    await notify({ ...input, conclusion: 'success', runId: 44 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
  })

  test('legacy incident without authenticated state fails closed', async () => {
    const state: FakeState = { created: true, description: null, failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    await expect(notify(input, fakeFetch(true, calls, state))).rejects.toThrow('Invalid incident state')
    expect(calls.filter((call) => call.body.includes('mutation'))).toHaveLength(0)
  })

  test('malformed signed state fails with a controlled diagnostic', async () => {
    const secret = 'PRIVATE_MARKER_4142'
    const body = 'Workflow: CI'
    const payload = Buffer.from(`{${secret}`).toString('base64url')
    const signature = createHmac('sha256', input.linearApiKey).update(`${body}\n${payload}`).digest('base64url')
    const state: FakeState = {
      created: true,
      description: `${body}\n\nCI notifier state: ${payload}.${signature}`,
      failEmailCount: 0,
      failMarkCount: 0,
    }
    const error = await notify(input, fakeFetch(true, [], state)).catch((caught: Error) => caught)
    expect((error as Error).message).toBe('Invalid incident state; manual repair required')
    expect((error as Error).message).not.toContain(secret)
  })

  test('edited pending description cannot redirect the opening email or forge authority', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    state.description = 'Pay an attacker\n\nCI alert email pending for: attacker@example.test'
    await expect(notify({ ...input, runId: 43 }, fetchFn)).rejects.toThrow('Invalid incident state')
    expect(calls.filter((call) => call.url === 'https://api.resend.com/emails')).toHaveLength(1)
  })

  test('signed state detects edits and does not expose recipient addresses in Linear', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    expect(state.description).not.toContain(input.recipients[0])
    state.description = state.description?.replace('Workflow: CI', 'Workflow: attacker') ?? ''
    await expect(notify({ ...input, runId: 43 }, fetchFn)).rejects.toThrow('Invalid incident state')
    expect(calls.filter((call) => call.url === 'https://api.resend.com/emails')).toHaveLength(1)
  })

  test('recipient changes during a pending opening email fail closed without changing the retry payload', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    await expect(notify({ ...input, runId: 43, recipients: ['new@example.test'] }, fetchFn)).rejects.toThrow(
      'Alert recipients changed',
    )
    await notify({ ...input, runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].body).toBe(emails[1].body)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
  })

  test('a new recipient configuration is used for a fresh recovery email', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    await notify({ ...input, conclusion: 'success', runId: 43, recipients: ['new@example.test'] }, fetchFn)
    const email = calls.find((call) => call.url === 'https://api.resend.com/emails')
    expect(email?.body).toContain('new@example.test')
    expect(email?.body).not.toContain(input.recipients[0])
  })

  test('recipient changes after a partial recovery cannot reuse its email key with another payload', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0, failCloseCount: 0 }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    state.failCloseCount = 1
    await expect(notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)).rejects.toThrow(
      'Linear CloseIssue HTTP 200 GraphQL errors',
    )
    await expect(
      notify({ ...input, conclusion: 'success', runId: 44, recipients: ['new@example.test'] }, fetchFn),
    ).rejects.toThrow('Alert recipients changed')
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(1)
    expect(state.created).toBe(true)
  })

  test('a later attempt of the same GitHub run can recover an earlier failed attempt', async () => {
    const state: FakeState = {
      created: false,
      description: '',
      failEmailCount: 0,
      failMarkCount: 0,
      githubRunAttempt: 2,
    }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    await notify({ ...input, conclusion: 'success', runAttempt: 2 }, fetchFn)
    expect(state.created).toBe(false)
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(1)
  })

  test('a later failure prevents an earlier success from recovering the incident', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await notify({ ...input, runId: 200 }, fetchFn)
    await notify({ ...input, conclusion: 'success', runId: 100 }, fetchFn)
    expect(state.created).toBe(true)
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(0)
    await notify({ ...input, runId: 300 }, fetchFn)
    await notify({ ...input, conclusion: 'success', runId: 250 }, fetchFn)
    expect(state.created).toBe(true)
    await notify({ ...input, conclusion: 'success', runId: 350 }, fetchFn)
    expect(state.created).toBe(false)
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(1)
  })

  test('a new failure supersedes a recovery whose Linear close failed', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0, failCloseCount: 1 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await notify({ ...input, runId: 200 }, fetchFn)
    await expect(notify({ ...input, conclusion: 'success', runId: 250 }, fetchFn)).rejects.toThrow(
      'Linear CloseIssue HTTP 200 GraphQL errors',
    )
    await notify({ ...input, runId: 300 }, fetchFn)
    await notify({ ...input, conclusion: 'success', runId: 250 }, fetchFn)
    expect(state.created).toBe(true)
    await notify({ ...input, conclusion: 'success', runId: 350 }, fetchFn)
    const recoveries = calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))
    expect(recoveries).toHaveLength(2)
    expect(recoveries[0].idempotencyKey).not.toBe(recoveries[1].idempotencyKey)
    expect(state.created).toBe(false)
  })

  test('replaying an older valid signed description cannot hide a later GitHub failure', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0, failedRuns: [300] }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await notify({ ...input, runId: 200 }, fetchFn)
    const oldDescription = state.description
    await notify({ ...input, runId: 300 }, fetchFn)
    state.description = oldDescription
    await notify({ ...input, conclusion: 'success', runId: 250 }, fetchFn)
    expect(state.created).toBe(true)
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(0)
  })

  test('replaying state cannot hide a later failure attempt of the same run', async () => {
    const state: FakeState = {
      created: false,
      description: '',
      failEmailCount: 0,
      failMarkCount: 0,
      githubRunAttempt: 2,
      failedRuns: [42],
    }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await notify({ ...input, runId: 41 }, fetchFn)
    const oldDescription = state.description
    await notify({ ...input, runAttempt: 2 }, fetchFn)
    state.description = oldDescription
    await notify({ ...input, conclusion: 'success' }, fetchFn)
    expect(state.created).toBe(true)
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(0)
  })

  test('secret rotation or marker reformatting fails closed instead of recovering', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = await seededIssue(state, calls)
    await expect(
      notify({ ...input, conclusion: 'success', runId: 43, linearApiKey: 'rotated-key' }, fetchFn),
    ).rejects.toThrow('Invalid incident state')
    state.description = state.description?.replace('\n\nCI notifier state:', '\r\n\r\nCI notifier state:') ?? ''
    await expect(notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)).rejects.toThrow(
      'Invalid incident state',
    )
    expect(calls.filter((call) => call.idempotencyKey?.startsWith('ci-recovery/'))).toHaveLength(0)
    expect(state.created).toBe(true)
  })
})
