/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createClient } from '@/lib/http'
import { createMockHttpClient } from '@/test-utils/http-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { useInviteAcceptState } from './use-invite-accept-state'

describe('useInviteAcceptState', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  const renderState = async (options: Parameters<typeof createMockAuthClient>[0]) => {
    const wrapper = createTestProvider({
      httpClient: createMockHttpClient({ email: 'invited@corp.com', expiresAt: '2026-11-21T00:00:00.000Z' }),
      authClient: createMockAuthClient(options),
    })
    const rendered = renderHook(() => useInviteAcceptState('token'), { wrapper })
    await act(async () => {
      await getClock().runAllAsync()
    })
    return rendered
  }

  it('waits for the session before deciding', async () => {
    const { result } = await renderState({ isPending: true })

    expect(result.current.state).toEqual({ status: 'loading' })
  })

  it('shows the invitation to a signed-out visitor', async () => {
    const { result } = await renderState({ session: null })

    expect(result.current.state).toEqual({ status: 'valid', email: 'invited@corp.com' })
  })

  it('keeps the invitation on screen once sign-in started here, even after the session arrives', async () => {
    const { result } = await renderState({ session: { user: { id: 'u1', email: 'invited@corp.com' } } })
    expect(result.current.state).toEqual({ status: 'signed-in', email: 'invited@corp.com' })

    act(() => result.current.onSignInStarted())

    expect(result.current.state).toEqual({ status: 'valid', email: 'invited@corp.com' })
  })

  describe('once sign-in started here', () => {
    const invitation = { email: 'invited@corp.com', expiresAt: '2026-11-21T00:00:00.000Z' }

    /** A session and a backend the test can change between renders. */
    const renderChanging = async () => {
      const live = { session: { data: null as unknown, isPending: false }, status: 200 }
      const baseAuth = createMockAuthClient()
      const authClient = {
        ...baseAuth,
        useSession: () => ({ ...baseAuth.useSession(), ...live.session }),
      } as typeof baseAuth
      const httpClient = createClient({
        prefixUrl: 'http://backend.test',
        fetch: async () =>
          new Response(JSON.stringify(live.status === 200 ? invitation : { code: 'INVITATION_NOT_FOUND' }), {
            status: live.status,
          }),
      })
      const rendered = renderHook(() => useInviteAcceptState('token'), {
        wrapper: createTestProvider({ httpClient, authClient }),
      })
      await act(async () => {
        await getClock().runAllAsync()
      })
      act(() => rendered.result.current.onSignInStarted())
      return { ...rendered, live }
    }

    it('keeps the form while the session refetches as pending', async () => {
      const { result, rerender, live } = await renderChanging()

      live.session = { data: null, isPending: true }
      rerender()

      expect(result.current.state).toEqual({ status: 'valid', email: 'invited@corp.com' })
    })

    it('keeps the form when a refetch finds the invitation consumed', async () => {
      const { result, live } = await renderChanging()

      live.status = 404
      await act(async () => {
        await result.current.retry()
        await getClock().runAllAsync()
      })

      expect(result.current.state).toEqual({ status: 'valid', email: 'invited@corp.com' })
    })
  })
})
