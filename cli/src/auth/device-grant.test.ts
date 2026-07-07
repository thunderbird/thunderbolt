/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * State-machine coverage for the RFC 8628 poll loop. Time and the network are
 * injected (DI over mocking): a controllable fake clock records sleeps and
 * advances a virtual now on each sleep, and a scripted transport returns a queued
 * sequence of poll results. No real timers or sockets are touched.
 */

import { describe, expect, it } from 'bun:test'
import { DeviceGrantError, pollForToken, type DeviceCodeResponse, type TokenPollResult } from './device-grant.ts'

const code: DeviceCodeResponse = {
  deviceCode: 'dev-code',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://app.test/device',
  verificationUriComplete: 'https://app.test/device?user_code=WDJB-MJHT',
  intervalSeconds: 5,
  expiresInSeconds: 300,
}

/** Fake clock: `sleep` advances a virtual now and logs the requested delay. */
const fakeClock = (start = 0) => {
  const sleeps: number[] = []
  const state = { now: start }
  return {
    sleeps,
    clock: {
      now: () => state.now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        state.now += ms
      },
    },
  }
}

/** Transport that dispenses a scripted sequence of `pollToken` results. */
const scriptedTransport = (results: TokenPollResult[]) => {
  const calls = { count: 0 }
  return {
    calls,
    transport: {
      requestCode: async () => code,
      pollToken: async () => {
        const next = results[calls.count]
        calls.count += 1
        if (!next) throw new Error('transport exhausted: pollToken called more times than scripted')
        return next
      },
    },
  }
}

describe('pollForToken', () => {
  it('polls immediately, then sleeps the interval between attempts, until approved', async () => {
    const { clock, sleeps } = fakeClock()
    const { transport, calls } = scriptedTransport([
      { kind: 'pending' },
      { kind: 'pending' },
      { kind: 'approved', token: 'signed.jwt' },
    ])

    expect(await pollForToken(code, transport, clock)).toBe('signed.jwt')
    expect(calls.count).toBe(3)
    // Poll-first: three polls, an interval sleep only *between* them (no lead wait).
    expect(sleeps).toEqual([5000, 5000])
  })

  it('widens the interval by 5s after slow_down (RFC 8628 §3.5)', async () => {
    const { clock, sleeps } = fakeClock()
    const { transport } = scriptedTransport([
      { kind: 'pending' },
      { kind: 'slow_down' },
      { kind: 'approved', token: 'tok' },
    ])

    await pollForToken(code, transport, clock)
    expect(sleeps).toEqual([5000, 10000])
  })

  it('throws access_denied when the user denies (on the very first poll)', async () => {
    const { clock, sleeps } = fakeClock()
    const { transport, calls } = scriptedTransport([{ kind: 'denied' }])

    const err = await pollForToken(code, transport, clock).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceGrantError)
    expect((err as DeviceGrantError).reason).toBe('access_denied')
    expect(calls.count).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('throws expired_token when the server reports expiry', async () => {
    const { clock } = fakeClock()
    const { transport } = scriptedTransport([{ kind: 'pending' }, { kind: 'expired' }])

    const err = await pollForToken(code, transport, clock).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceGrantError)
    expect((err as DeviceGrantError).reason).toBe('expired_token')
  })

  it('enforces the client-side deadline as a backstop once elapsed', async () => {
    const { clock } = fakeClock()
    // Deadline 6s out with a 5s interval: poll, sleep 5s, poll, sleep 5s → now 10s > 6s.
    const shortCode = { ...code, expiresInSeconds: 6 }
    const { transport, calls } = scriptedTransport([{ kind: 'pending' }, { kind: 'pending' }])

    const err = await pollForToken(shortCode, transport, clock).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceGrantError)
    expect((err as DeviceGrantError).reason).toBe('expired_token')
    expect(calls.count).toBe(2)
  })
})
