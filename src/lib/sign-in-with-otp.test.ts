/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createAuthClient } from 'better-auth/react'
import { anonymousClient, emailOTPClient } from 'better-auth/client/plugins'
import { buildFetchOptions, createAuthClientInstance } from '@/contexts/auth-context'
import { clearAuthToken, getAuthToken, setAuthToken } from '@/lib/auth-token'
import * as onboarding from '@/lib/returning-user-onboarding'
import { getClock } from '@/testing-library'
import { getLocalDataStatus, isLocalDataOwnedBy, openLocalData, resetLocalDataOwnerForTests } from './local-data-owner'
import * as platform from './platform'
import { signInWithOtp } from './sign-in-with-otp'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

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

describe('OTP promotion of an anonymous session (THU-963)', () => {
  let previousLocalSettings: ReturnType<typeof useLocalSettingsStore.getState>

  beforeEach(() => {
    previousLocalSettings = useLocalSettingsStore.getState()
  })

  /**
   * Signs in from `previous` with the app's own client, whose session subscriber binds the sessions
   * it hears of. Only the sign-in's own bind passes the anonymous slot to the new account, so it must
   * come first.
   */
  const signIn = async (previous: { id: string; isAnonymous: boolean }) => {
    localStorage.clear()
    useLocalSettingsStore.setState({ cloudUrl: 'https://auth.test/v1' })
    spyOn(platform, 'isOpfsAvailable').mockResolvedValue(false)
    spyOn(platform, 'hasIndexedDbDatabase').mockResolvedValue(false)
    spyOn(onboarding, 'markOnboardedForReturningUser').mockResolvedValue()
    const previousSession = { user: previous, session: { token: 'previous' } }
    const server = { isSignedIn: false }
    const respond = async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/sign-in/email-otp')) {
        return Response.json(server.isSignedIn ? accepted : previousSession)
      }
      server.isSignedIn = true
      return Response.json(accepted, { headers: { 'set-auth-token': 'accepted.signature' } })
    }
    spyOn(globalThis, 'fetch').mockImplementation(Object.assign(respond, { preconnect: globalThis.fetch.preconnect }))
    resetLocalDataOwnerForTests()
    await openLocalData()
    // Boot has finished; any later switch stops here, waiting on the switch lock.
    spyOn(navigator.locks, 'request').mockReturnValue(new Promise(() => {}))
    const client = createAuthClientInstance('https://auth.test/v1')
    const atom = client.$store.atoms.session
    atom.set({ ...atom.get(), data: previousSession, isPending: false })
    expect(isLocalDataOwnedBy(previous.id)).toBe(true)
    await signInWithOtp(client, { email: 'test@example.com', otp: '12345678' })
    // Better Auth tells its session listeners on a timer, after a `/get-session` refetch.
    await getClock().tickAsync(20)
    expect(atom.get().data?.user.id).toBe('accepted-user')
  }

  afterEach(() => {
    resetLocalDataOwnerForTests()
    localStorage.clear()
    useLocalSettingsStore.setState(previousLocalSettings)
  })

  it('hands the anonymous account’s local data to the account it became, before the session listeners hear of it', async () => {
    await signIn({ id: 'anon-1', isAnonymous: true })
    expect(isLocalDataOwnedBy('accepted-user')).toBe(true)
    expect(getLocalDataStatus()).toBe('ready')
  })

  it('never hands a named account’s local data to the next sign-in, and switches instead', async () => {
    await signIn({ id: 'user-a', isAnonymous: false })
    expect(isLocalDataOwnedBy('accepted-user')).toBe(false)
    expect(getLocalDataStatus()).toBe('switching')
  })
})
