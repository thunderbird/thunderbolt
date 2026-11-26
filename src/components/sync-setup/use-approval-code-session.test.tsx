/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts/http-client-context'
import { createApprovalCommitment, deriveApprovalCode } from '@/crypto/device-approval-code'
import { getClock } from '@/testing-library'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { approvalSessionTtlMs } from '@shared/e2ee-types'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import { useApprovalCodeSession } from './use-approval-code-session'

type Row = { sessionId: string; challenge: string | null; challengerDeviceId: string | null; expired: boolean }

/** A stand-in for the relay routes: records every POST and serves whatever row the test sets. */
const createRelay = () => {
  const relay = {
    row: null as Row | null,
    starts: [] as Array<{ sessionId: string; commitment: string }>,
    reveals: [] as Array<{ sessionId: string; reveal: string }>,
    failStart: false,
    /** GETs answer with this status instead of the row. */
    pollStatus: 200,
    /** When set, GETs wait for it: a poll still in flight. */
    gate: null as Promise<void> | null,
  }
  const { httpClient } = createSpyHttpClient(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/devices/me/approval-session')) {
      if (relay.failStart) {
        return jsonResponse({ error: 'Not found' }, 404)
      }
      const body = await request.json()
      relay.starts.push(body)
      if (relay.row?.sessionId !== body.sessionId) {
        relay.row = { sessionId: body.sessionId, challenge: null, challengerDeviceId: null, expired: false }
      }
      return new Response(null, { status: 204 })
    }
    if (request.method === 'GET' && path.endsWith('/devices/me/approval-session')) {
      await relay.gate
      if (relay.pollStatus !== 200) {
        return jsonResponse({ error: 'Refused' }, relay.pollStatus)
      }
      return relay.row ? jsonResponse(relay.row) : jsonResponse({ error: 'Not found' }, 404)
    }
    if (request.method === 'POST' && path.endsWith('/devices/me/approval-session/reveal')) {
      relay.reveals.push(await request.json())
      return new Response(null, { status: 204 })
    }
    return jsonResponse({ error: 'Unexpected' }, 500)
  })
  return { relay, httpClient }
}

const getContext = async (sessionId: string) => `context:${sessionId}`

/** Native crypto resolves outside the fake clock, so let real macrotasks run inside act. */
const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  })
}

/** Let real macrotasks run until the hook reaches the expected state (native crypto has no fixed latency). */
const settleUntil = async (done: () => boolean, timeoutMs = 5000) => {
  // performance.now() is not faked, so this budget is real time even with the fake clock installed.
  const deadline = performance.now() + timeoutMs
  while (!done() && performance.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve))
    })
  }
}

const tick = async (ms = 1500) => {
  await act(async () => {
    await getClock().tickAsync(ms)
  })
  await settle()
}

const renderSession = () => {
  const { relay, httpClient } = createRelay()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
  )
  const hook = renderHook(() => useApprovalCodeSession({ getContext }), { wrapper })
  return { relay, hook }
}

const challenge = 'a'.repeat(64)

describe('useApprovalCodeSession', () => {
  afterEach(() => {
    cleanup()
  })

  it('commits once and waits for a challenge', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    expect(hook.result.current.status).toBe('waiting')
    expect(relay.starts).toHaveLength(1)
    expect(relay.starts[0].sessionId).toMatch(/^[0-9a-f]{32}$/)
    expect(relay.starts[0].commitment).toMatch(/^[0-9a-f]{64}$/)
    await tick()
    expect(relay.reveals).toEqual([])
  })

  it('records the first challenge, reveals once, and shows the matching code', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    const { sessionId } = relay.starts[0]
    relay.row = { sessionId, challenge, challengerDeviceId: 'trusted-1', expired: false }
    await tick()
    await settleUntil(() => relay.reveals.length === 1)
    expect(hook.result.current.status).toBe('showing')
    expect(relay.reveals).toHaveLength(1)
    const { reveal } = relay.reveals[0]
    expect(await createApprovalCommitment(await getContext(sessionId), reveal)).toBe(relay.starts[0].commitment)
    expect(hook.result.current.code).toBe(
      await deriveApprovalCode(await getContext(sessionId), 'trusted-1', challenge, reveal),
    )

    const shown = hook.result.current.code
    relay.row = { sessionId, challenge: 'c'.repeat(64), challengerDeviceId: 'trusted-2', expired: false }
    await tick()
    await tick()
    expect(relay.reveals).toHaveLength(1)
    expect(hook.result.current.code).toBe(shown)
  })

  it('never reveals for a screen that is gone', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    let release = () => {}
    relay.gate = new Promise((resolve) => {
      release = resolve
    })
    relay.row = { sessionId: relay.starts[0].sessionId, challenge, challengerDeviceId: 'trusted-1', expired: false }
    await tick()
    hook.unmount()
    release()
    await settle()
    expect(relay.reveals).toEqual([])
  })

  it('offers a new code once another start replaced this attempt on the server', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    relay.row = { sessionId: 'f'.repeat(32), challenge, challengerDeviceId: 'trusted-1', expired: false }
    await tick()
    expect(hook.result.current.status).toBe('failed')
    expect(hook.result.current.code).toBeNull()
    expect(relay.reveals).toEqual([])
  })

  it('expires when the server says so, and starts fresh on New code', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    const first = relay.starts[0].sessionId
    relay.row = { ...relay.row!, expired: true }
    await tick()
    await settleUntil(() => hook.result.current.status === 'expired')
    expect(hook.result.current.status).toBe('expired')

    act(() => hook.result.current.newCode())
    await settleUntil(() => hook.result.current.status === 'waiting')
    expect(hook.result.current.status).toBe('waiting')
    expect(relay.starts).toHaveLength(2)
    expect(relay.starts[1].sessionId).not.toBe(first)
  })

  it('expires on the local clock even when the server never says so', async () => {
    const { hook } = renderSession()
    await settle()
    await tick(approvalSessionTtlMs)
    // Polls are skipped while one is in flight; keep ticking (real-time bounded) until one runs past the deadline.
    const deadline = performance.now() + 5000
    while (hook.result.current.status !== 'expired' && performance.now() < deadline) {
      await tick()
    }
    expect(hook.result.current.status).toBe('expired')
  })

  it('keeps its local expiry when a poll is never answered', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    relay.gate = new Promise(() => {})
    await tick()
    // The held poll is abandoned after 10 seconds, so later ticks still reach the local deadline.
    for (let elapsed = 0; elapsed <= approvalSessionTtlMs + 20_000; elapsed += 10_000) {
      await tick(10_000)
    }
    expect(hook.result.current.status).toBe('expired')
  })

  it('does not reveal for a challenge the server held until past the deadline', async () => {
    const { relay, hook } = renderSession()
    await settleUntil(() => hook.result.current.status === 'waiting')
    await tick(approvalSessionTtlMs - 3000)
    const release = Promise.withResolvers<void>()
    relay.gate = release.promise
    relay.row = { sessionId: relay.starts[0].sessionId, challenge, challengerDeviceId: 'trusted-1', expired: false }
    await tick()
    await tick(3000)
    release.resolve()
    await settleUntil(() => hook.result.current.status === 'expired')
    expect(hook.result.current.status).toBe('expired')
    expect(hook.result.current.code).toBeNull()
    expect(relay.reveals).toEqual([])
  })

  it('logs one fixed line per attempt while polls keep failing', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { relay, hook } = renderSession()
      await settleUntil(() => hook.result.current.status === 'waiting')
      relay.pollStatus = 500
      await tick()
      await tick()
      await tick()
      expect(errorLog.mock.calls).toEqual([['Failed to poll for the approval code.']])

      relay.row = { ...relay.row!, expired: true }
      relay.pollStatus = 200
      await tick()
      await settleUntil(() => hook.result.current.status === 'expired')
      act(() => hook.result.current.newCode())
      await settleUntil(() => hook.result.current.status === 'waiting')
      relay.pollStatus = 500
      await tick()
      await tick()
      expect(errorLog).toHaveBeenCalledTimes(2)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('does not log the protocol answers for an approved device (409) or a missing session (404)', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { relay, hook } = renderSession()
      await settleUntil(() => hook.result.current.status === 'waiting')
      relay.pollStatus = 409
      await tick()
      await tick()
      relay.pollStatus = 404
      await tick()
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })

  it('falls back to unavailable when the session cannot start', async () => {
    const { relay, httpClient } = createRelay()
    relay.failStart = true
    const wrapper = ({ children }: { children: ReactNode }) => (
      <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
    )
    const hook = renderHook(() => useApprovalCodeSession({ getContext }), { wrapper })
    await settleUntil(() => hook.result.current.status === 'unavailable')
    expect(hook.result.current.status).toBe('unavailable')
  })
})
