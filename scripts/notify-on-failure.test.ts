/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { notify, type NotificationInput } from './notify-on-failure'

const input: NotificationInput = {
  workflowName: 'CI',
  runId: 42,
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
}

const fakeFetch = (existingIssue: boolean, calls: Call[], state?: FakeState): typeof fetch =>
  (async (request, init) => {
    const url = String(request)
    const body = String(init?.body ?? '')
    calls.push({ url, body, idempotencyKey: new Headers(init?.headers).get('Idempotency-Key') })
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
    if (body.includes('mutation MarkFailureEmailSent')) {
      if (state?.failMarkCount) {
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

  test('repeat failure adds a comment without another email', async () => {
    const calls: Call[] = []
    await notify(input, fakeFetch(true, calls))
    expect(calls.some((call) => call.body.includes('mutation Comment'))).toBe(true)
    expect(calls.some((call) => call.body.includes('mutation CreateIssue'))).toBe(false)
    expect(calls.some((call) => call.url === 'https://api.resend.com/emails')).toBe(false)
  })

  test('recovery closes an open incident and sends an email', async () => {
    const calls: Call[] = []
    await notify({ ...input, conclusion: 'success' }, fakeFetch(true, calls))
    expect(calls.find((call) => call.body.includes('mutation CloseIssue'))?.body).toContain('"stateId":"done-id"')
    expect(calls.filter((call) => call.url === 'https://api.resend.com/emails')).toHaveLength(1)
    expect(calls.some((call) => call.url.includes('/actions/runs/'))).toBe(false)
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
    await expect(notify(input, fetchFn)).rejects.toThrow('Linear: Query failed')
    expect(calls.some((call) => call.body.includes('mutation') || call.url === 'https://api.resend.com/emails')).toBe(
      false,
    )
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
    await expect(notify(input, fetchFn)).rejects.toThrow('Linear: Creation failed')
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
    expect(state.description).toContain('CI alert email pending for:')
    await notify({ ...input, runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
    expect(emails[0].body).toContain('/actions/runs/42')
    expect(state.description).not.toContain('CI alert email pending for:')
    expect(calls.filter((call) => call.body.includes('mutation CreateIssue'))).toHaveLength(1)
    expect(calls.filter((call) => call.body.includes('mutation Comment'))).toHaveLength(1)
  })

  test('recovery completes a pending opening email before closing the incident', async () => {
    const state: FakeState = { created: false, description: '', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(false, calls, state)
    await expect(notify(input, fetchFn)).rejects.toThrow('HTTP 503')
    expect(state.description).toContain('CI alert email pending for:')

    await notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)

    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(3)
    expect(emails[0].body).toBe(emails[1].body)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[2].idempotencyKey).not.toBe(emails[1].idempotencyKey)
    expect(state.description).not.toContain('CI alert email pending for:')
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
    await expect(notify(input, fetchFn)).rejects.toThrow('Linear update failed')
    await notify({ ...input, runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
    expect(state.description).not.toContain('CI alert email pending for:')
  })

  test('failed recovery email keeps the incident open for a stable retry', async () => {
    const state: FakeState = { created: true, description: 'Original failure', failEmailCount: 1, failMarkCount: 0 }
    const calls: Call[] = []
    const fetchFn = fakeFetch(true, calls, state)
    await expect(notify({ ...input, conclusion: 'success' }, fetchFn)).rejects.toThrow('HTTP 503')
    expect(calls.some((call) => call.body.includes('mutation CloseIssue'))).toBe(false)
    await notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
    expect(calls.filter((call) => call.body.includes('mutation CloseIssue'))).toHaveLength(1)
  })

  test('accepted recovery email with failed close retries the same payload and key', async () => {
    const state: FakeState = {
      created: true,
      description: 'Original failure',
      failEmailCount: 0,
      failMarkCount: 0,
      failCloseCount: 1,
    }
    const calls: Call[] = []
    const fetchFn = fakeFetch(true, calls, state)
    await expect(notify({ ...input, conclusion: 'success' }, fetchFn)).rejects.toThrow('Close failed')
    await notify({ ...input, conclusion: 'success', runId: 43 }, fetchFn)
    const emails = calls.filter((call) => call.url === 'https://api.resend.com/emails')
    expect(emails).toHaveLength(2)
    expect(emails[0].idempotencyKey).toBe(emails[1].idempotencyKey)
    expect(emails[0].body).toBe(emails[1].body)
  })

  test('existing incident without a description still receives repeat failure comment', async () => {
    const state: FakeState = { created: true, description: null, failEmailCount: 0, failMarkCount: 0 }
    const calls: Call[] = []
    await notify(input, fakeFetch(true, calls, state))
    expect(calls.filter((call) => call.body.includes('mutation Comment'))).toHaveLength(1)
  })
})
