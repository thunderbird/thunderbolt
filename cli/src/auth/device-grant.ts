/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The RFC 8628 device-authorization grant state machine, isolated from I/O so the
 * poll loop is fully unit-testable. Time (`Clock`) and the network
 * (`DeviceGrantTransport`) are injected; the loop itself is pure control flow:
 * sleep the interval, poll, and act on the result — approving, backing off on
 * `slow_down`, or aborting on denial / expiry.
 */

/** Injected time seam: current epoch millis + an awaitable sleep. Real impl is
 *  {@link systemClock}; tests pass a controllable fake (no real timers). */
export type Clock = {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

/** Wall-clock implementation of {@link Clock} backed by `Date.now` / `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Parsed `/device/code` response (RFC 8628 §3.2), normalized to camelCase. */
export type DeviceCodeResponse = {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete: string
  readonly intervalSeconds: number
  readonly expiresInSeconds: number
}

/** Outcome of one `/device/token` poll (RFC 8628 §3.5). `approved` carries the
 *  signed bearer; the rest map the standard error codes. */
export type TokenPollResult =
  | { readonly kind: 'approved'; readonly token: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'slow_down' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'expired' }

/** Network seam for the device grant: request codes, then poll for the token. */
export type DeviceGrantTransport = {
  readonly requestCode: () => Promise<DeviceCodeResponse>
  readonly pollToken: (deviceCode: string) => Promise<TokenPollResult>
}

/** Terminal reasons the grant can fail with, surfaced to the user. */
export type DeviceGrantReason = 'access_denied' | 'expired_token'

/** Raised when the grant ends without a token (user denied, or the code expired). */
export class DeviceGrantError extends Error {
  constructor(
    readonly reason: DeviceGrantReason,
    message: string,
  ) {
    super(message)
    this.name = 'DeviceGrantError'
  }
}

/** RFC 8628 §3.5: on `slow_down`, the client raises its poll interval by 5s. */
const slowDownIncrementMs = 5000

/**
 * Poll the token endpoint until the user approves, denies, or the code expires.
 * Polls immediately, then waits `interval` between attempts, widening it by 5s on
 * `slow_down`. A client-side deadline from `expiresInSeconds` backstops the
 * server's own `expired_token`. Polling first (rather than sleeping first) avoids
 * an initial dead wait and the pathological case where a short-lived code expires
 * before the CLI ever asks the endpoint.
 *
 * @param code - the device/user codes from {@link DeviceGrantTransport.requestCode}
 * @param transport - network seam used to poll the token endpoint
 * @param clock - injected time seam (real: {@link systemClock})
 * @returns the signed bearer token on approval
 * @throws {DeviceGrantError} when the user denies or the code expires
 */
export const pollForToken = async (
  code: DeviceCodeResponse,
  transport: DeviceGrantTransport,
  clock: Clock,
): Promise<string> => {
  const deadlineMs = clock.now() + code.expiresInSeconds * 1000

  const poll = async (intervalMs: number): Promise<string> => {
    if (clock.now() >= deadlineMs) {
      throw new DeviceGrantError('expired_token', 'the device code expired before it was approved')
    }

    const result = await transport.pollToken(code.deviceCode)
    if (result.kind === 'approved') return result.token
    if (result.kind === 'denied') {
      throw new DeviceGrantError('access_denied', 'login was denied on the approval page')
    }
    if (result.kind === 'expired') {
      throw new DeviceGrantError('expired_token', 'the device code expired before it was approved')
    }

    const nextIntervalMs = result.kind === 'slow_down' ? intervalMs + slowDownIncrementMs : intervalMs
    await clock.sleep(nextIntervalMs)
    return poll(nextIntervalMs)
  }

  return poll(code.intervalSeconds * 1000)
}
