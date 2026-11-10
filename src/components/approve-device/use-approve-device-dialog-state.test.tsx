/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts/http-client-context'
import { DeviceApprovalError } from '@/crypto/errors'
import { HttpError } from '@/lib/http'
import { getClock } from '@/testing-library'
import { createSpyHttpClient, jsonResponse } from '@/test-utils/http-client-spy'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ReactNode } from 'react'
import { approvalCodeAttemptsKey, canUseApprovalCode, startApprovalCodeAttempt } from './approval-code-attempts'
import { type PendingDeviceKeys, useApproveDeviceDialogState } from './use-approve-device-dialog-state'

const device = { id: 'pending-1', publicKey: 'ecdh-1', mlkemPublicKey: 'mlkem-1' }
const sessionId = '0'.repeat(32)
const commitment = 'c'.repeat(64)
const reveal = 'b'.repeat(64)
const code = '42'

type Relay = {
  row: { sessionId: string; commitment: string; reveal: string | null; expired: boolean } | null
  challenges: Array<{ sessionId: string; challenge: string }>
  challengeStatus: number
  /** A server holding its answer: GETs wait this long (fake clock) before responding. */
  getDelayMs: number
}

/** The relay as the trusted device sees it: serves the pending device's row, records challenges. */
const createRelay = (overrides: Partial<Relay>) => {
  const relay: Relay = {
    row: { sessionId, commitment, reveal: null, expired: false },
    challenges: [],
    challengeStatus: 204,
    getDelayMs: 0,
    ...overrides,
  }
  const { httpClient } = createSpyHttpClient(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path.endsWith(`/devices/${device.id}/approval-session`)) {
      if (relay.getDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, relay.getDelayMs))
      }
      return relay.row ? jsonResponse(relay.row) : jsonResponse({ error: 'Not found' }, 404)
    }
    if (request.method === 'POST' && path.endsWith(`/devices/${device.id}/approval-session/challenge`)) {
      relay.challenges.push(await request.json())
      return relay.challengeStatus === 204
        ? new Response(null, { status: 204 })
        : jsonResponse({ error: 'Conflict' }, relay.challengeStatus)
    }
    return jsonResponse({ error: 'Unexpected' }, 500)
  })
  return { relay, httpClient }
}

/** Stands in for the crypto (covered in device-approval-code.test.ts): opens only the honest commitment. */
const createDeriveCode = () =>
  mock(async (_device: PendingDeviceKeys, attempt: { commitment: string }) =>
    attempt.commitment === commitment ? code : null,
  )

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  })
}

const tick = async (ms = 1500) => {
  await act(async () => {
    await getClock().tickAsync(ms)
  })
  await settle()
}

/** Mounting is opening the dialog, so the attempt starts on render; `relay` sets the server up first. */
const renderDialogState = (options: { onConfirm?: () => Promise<void>; relay?: Partial<Relay> } = {}) => {
  const { relay, httpClient } = createRelay(options.relay ?? {})
  const deriveCode = createDeriveCode()
  const onConfirm = mock(options.onConfirm ?? (async () => {}))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>{children}</HttpClientProvider>
  )
  const hook = renderHook(
    ({ target }: { target: typeof device }) => useApproveDeviceDialogState({ device: target, onConfirm, deriveCode }),
    { wrapper, initialProps: { target: device } },
  )
  return { relay, hook, deriveCode, onConfirm }
}

/** Let the running attempt send its challenge, then let the pending device reveal. */
const reachPick = async (rendered: ReturnType<typeof renderDialogState>) => {
  await settle()
  rendered.relay.row = { ...rendered.relay.row!, reveal }
  await tick()
}

const countedAttempts = () => JSON.parse(localStorage.getItem(approvalCodeAttemptsKey) ?? '[]').length

describe('useApproveDeviceDialogState', () => {
  beforeEach(() => {
    // Tests run in random order, and other files open the dialog too: start every count from zero.
    localStorage.removeItem(approvalCodeAttemptsKey)
    spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    localStorage.removeItem(approvalCodeAttemptsKey)
  })

  it('starts on open, then offers six codes including the derived one', async () => {
    const rendered = renderDialogState()
    expect(rendered.hook.result.current.state.step).toBe('connecting')
    await reachPick(rendered)
    const { state } = rendered.hook.result.current
    expect(state.step).toBe('pick')
    expect(state.step === 'pick' && state.options).toHaveLength(6)
    expect(state.step === 'pick' && state.options).toContain(code)
    expect(rendered.relay.challenges).toEqual([{ sessionId, challenge: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(countedAttempts()).toBe(1)
  })

  it('approves with the frozen attempt and forgives it', async () => {
    const rendered = renderDialogState()
    rendered.hook.rerender({ target: { ...device, publicKey: 'substituted-ecdh' } })
    await settle()
    rendered.relay.row = { ...rendered.relay.row!, reveal }
    await tick()
    expect(rendered.deriveCode.mock.calls[0][0]).toEqual(device)

    await act(async () => rendered.hook.result.current.pick(code))
    expect(rendered.onConfirm).toHaveBeenCalledWith({
      kind: 'code',
      sessionId,
      commitment,
      challenge: rendered.relay.challenges[0].challenge,
      reveal,
      code,
    })
    expect(countedAttempts()).toBe(0)
  })

  it('treats a wrong tap and "None of these match" as a mismatch without approving', async () => {
    const rendered = renderDialogState()
    await reachPick(rendered)
    await act(async () => rendered.hook.result.current.pick('24'))
    expect(rendered.hook.result.current.state.step).toBe('mismatch')

    act(() => rendered.hook.result.current.start())
    await reachPick(rendered)
    act(() => rendered.hook.result.current.noneMatch())
    expect(rendered.hook.result.current.state.step).toBe('mismatch')
    expect(rendered.onConfirm).not.toHaveBeenCalled()
    expect(countedAttempts()).toBe(2)
  })

  it('reports a mismatch when the reveal does not open the commitment', async () => {
    const rendered = renderDialogState({
      relay: { row: { sessionId, commitment: 'e'.repeat(64), reveal: null, expired: false } },
    })
    await reachPick(rendered)
    expect(rendered.hook.result.current.state.step).toBe('mismatch')
    expect(countedAttempts()).toBe(1)
  })

  it('reports the new device as not showing a code after 60 seconds without a reveal', async () => {
    const rendered = renderDialogState()
    await settle()
    expect(rendered.hook.result.current.state.step).toBe('connecting')
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 1500) {
      await tick()
    }
    expect(rendered.hook.result.current.state.step).toBe('unavailable')
  })

  it('rejects a reveal the server held past the deadline', async () => {
    const rendered = renderDialogState()
    await settle()
    rendered.relay.row = { ...rendered.relay.row!, reveal }
    rendered.relay.getDelayMs = 70_000
    await tick()
    await tick(70_000)
    expect(rendered.hook.result.current.state.step).toBe('unavailable')
  })

  it('lets only one of several open dialogs take the last attempt', async () => {
    startApprovalCodeAttempt()
    startApprovalCodeAttempt()
    const first = renderDialogState()
    const second = renderDialogState()
    await settle()
    expect(countedAttempts()).toBe(3)
    expect([first, second].map((rendered) => rendered.hook.result.current.state.step).sort()).toEqual([
      'connecting',
      'fingerprint',
    ])
  })

  it('stops the running attempt when the fingerprint is chosen', async () => {
    const rendered = renderDialogState()
    await settle()
    act(() => rendered.hook.result.current.chooseFingerprint())
    rendered.relay.row = { ...rendered.relay.row!, reveal }
    await tick()
    expect(rendered.hook.result.current.state).toMatchObject({ step: 'fingerprint', reason: 'chosen' })
    expect(rendered.deriveCode).not.toHaveBeenCalled()
  })

  it('reports unavailable without counting when there is no session', async () => {
    const rendered = renderDialogState({ relay: { row: null } })
    await settle()
    expect(rendered.hook.result.current.state.step).toBe('unavailable')
    expect(countedAttempts()).toBe(0)
  })

  it('does not count a challenge the server refused', async () => {
    const rendered = renderDialogState({ relay: { challengeStatus: 409 } })
    await settle()
    expect(rendered.hook.result.current.state.step).toBe('unavailable')
    expect(countedAttempts()).toBe(0)
  })

  it('switches to the fingerprint once the daily limit is reached', async () => {
    startApprovalCodeAttempt()
    startApprovalCodeAttempt()
    const rendered = renderDialogState()
    await reachPick(rendered)
    act(() => rendered.hook.result.current.noneMatch())
    expect(canUseApprovalCode()).toBe(false)
    act(() => rendered.hook.result.current.start())
    expect(rendered.hook.result.current.state).toMatchObject({ step: 'fingerprint', reason: 'limit' })

    cleanup()
    const reopened = renderDialogState()
    expect(reopened.hook.result.current.state).toMatchObject({ step: 'fingerprint', reason: 'limit' })
  })

  it('keeps the codes on a conflict and reports a code mismatch from the service', async () => {
    const conflicting = renderDialogState({
      onConfirm: async () => {
        throw new HttpError(new Response(null, { status: 409 }))
      },
    })
    await reachPick(conflicting)
    await act(async () => conflicting.hook.result.current.pick(code))
    expect(conflicting.hook.result.current.state).toMatchObject({ step: 'pick', submitError: 'conflict' })
    cleanup()

    const mismatching = renderDialogState({
      onConfirm: async () => {
        throw new DeviceApprovalError('code-mismatch')
      },
    })
    await reachPick(mismatching)
    await act(async () => mismatching.hook.result.current.pick(code))
    expect(mismatching.hook.result.current.state.step).toBe('mismatch')
  })
})
