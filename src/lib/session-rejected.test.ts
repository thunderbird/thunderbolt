/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { setAuthToken } from './auth-token'
import { handleSessionRejected } from './session-rejected'

const unauthenticated = () => new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 })

describe('handleSessionRejected', () => {
  const originalDispatch = window.dispatchEvent
  let dispatchSpy: ReturnType<typeof mock>

  beforeEach(() => {
    localStorage.clear()
    dispatchSpy = mock(() => true)
    window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent
  })

  afterEach(() => {
    window.dispatchEvent = originalDispatch
    localStorage.clear()
  })

  it('fires session_expired when our backend rejects the session', async () => {
    setAuthToken('app-token')

    await handleSessionRejected(unauthenticated())

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect((dispatchSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: 'session_expired' })
  })

  it("ignores a provider's 401 relayed through the proxy", async () => {
    setAuthToken('app-token')

    await handleSessionRejected(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    )

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('ignores a 401 when there is no session to lose', async () => {
    await handleSessionRejected(unauthenticated())

    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('leaves the body for the caller', async () => {
    setAuthToken('app-token')
    const response = unauthenticated()

    await handleSessionRejected(response)

    expect(await response.json()).toEqual({ code: 'UNAUTHENTICATED' })
  })
})
