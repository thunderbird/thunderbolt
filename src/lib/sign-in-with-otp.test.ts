/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createAuthClient } from 'better-auth/react'
import { anonymousClient, emailOTPClient } from 'better-auth/client/plugins'
import { buildFetchOptions } from '@/contexts/auth-context'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import * as onboarding from '@/lib/returning-user-onboarding'
import { getClock } from '@/testing-library'
import { signInWithOtp } from './sign-in-with-otp'

const accepted = { user: { id: 'accepted-user', isNew: false }, session: { token: 'accepted' } }

/** Exercise Better Auth's real request hooks and session notifications with a controlled transport. */
const createClient = (fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  createAuthClient({
    baseURL: 'https://auth.test',
    plugins: [emailOTPClient(), anonymousClient()],
    fetchOptions: {
      ...buildFetchOptions('web'),
      customFetchImpl: Object.assign(fetch, { preconnect: () => {} }),
    },
  })

afterEach(() => {
  mock.restore()
  clearAuthToken()
})

describe('OTP authentication cancellation', () => {
  it.each(['headers', 'body'] as const)(
    'rejects a cancelled %s response before token or session publication',
    async (stage) => {
      setAuthToken('previous.signature')
      const controller = new AbortController()
      const transport = Promise.withResolvers<Response>()
      const stream = new TransformStream<Uint8Array>()
      const write = stream.writable.getWriter()
      const response = new Response(stream.readable, {
        headers: { 'content-type': 'application/json', 'set-auth-token': 'accepted.signature' },
      })
      const markOnboarded = spyOn(onboarding, 'markOnboardedForReturningUser').mockResolvedValue()
      const onAuthenticated = mock(() => {})
      const client = createClient(async (_input, init) => {
        expect(init?.signal).toBe(controller.signal)
        return stage === 'headers' ? transport.promise : response
      })
      const sessionBefore = client.$store.atoms.session.get().data
      const result = signInWithOtp(client, {
        email: 'test@example.com',
        otp: '12345678',
        signal: controller.signal,
        onAuthenticated,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await getClock().tickAsync(0)
      controller.abort()
      if (stage === 'headers') {
        transport.resolve(Response.json(accepted, { headers: { 'set-auth-token': 'accepted.signature' } }))
        await write.abort()
      } else {
        await write.write(new TextEncoder().encode(JSON.stringify(accepted)))
        await write.close()
      }
      expect(await result).toMatchObject({ name: 'AbortError' })
      await getClock().tickAsync(20)
      expect(getAuthToken()).toBe('previous.signature')
      expect(client.$store.atoms.session.get().data).toBe(sessionBefore)
      expect(onAuthenticated).not.toHaveBeenCalled()
      expect(markOnboarded).not.toHaveBeenCalled()
    },
  )

  it('commits before housekeeping and still finishes it if navigation aborts the signal', async () => {
    const housekeeping = Promise.withResolvers<void>()
    const controller = new AbortController()
    const markOnboarded = spyOn(onboarding, 'markOnboardedForReturningUser').mockReturnValue(housekeeping.promise)
    const client = createClient(async () =>
      Response.json(accepted, { headers: { 'set-auth-token': 'accepted.signature' } }),
    )
    const onAuthenticated = mock(() => {
      expect(getAuthToken()).toBe('accepted.signature')
      controller.abort()
    })
    const pending = signInWithOtp(client, {
      email: 'test@example.com',
      otp: '12345678',
      signal: controller.signal,
      onAuthenticated,
    })
    await getClock().tickAsync(0)
    expect(onAuthenticated).toHaveBeenCalledTimes(1)
    expect(markOnboarded).toHaveBeenCalledWith(accepted.user)
    housekeeping.resolve()
    expect((await pending).data?.user.id).toBe('accepted-user')
  })
})
