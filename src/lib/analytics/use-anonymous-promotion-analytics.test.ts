/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test'
import { createAnonymousPromotionAnalytics, PENDING_ANON_ID_KEY } from './use-anonymous-promotion-analytics'
import * as posthogModule from '@/lib/posthog'
import type { AuthClient } from '@/contexts'

// Mock posthog-js to prevent uninitialized client errors in tests
const mockAlias = mock(() => {})
mock.module('posthog-js', () => ({
  default: { alias: mockAlias },
}))

const makeAuthClient = (isAnonymous: boolean, userId = 'user-abc') =>
  ({
    getSession: async () => ({
      data: { user: { id: userId, isAnonymous } },
    }),
  }) as unknown as AuthClient

const makeEmptyAuthClient = () =>
  ({
    getSession: async () => ({ data: null }),
  }) as unknown as AuthClient

const makeRef = (initial: string | null = null) => ({ current: initial })

describe('createAnonymousPromotionAnalytics', () => {
  let trackEventSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    sessionStorage.clear()
    mockAlias.mockClear()
    trackEventSpy = spyOn(posthogModule, 'trackEvent').mockImplementation(() => {})
  })

  afterEach(() => {
    sessionStorage.clear()
    trackEventSpy.mockRestore()
  })

  it('captureAnonId stores the id when session is anonymous', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))

    expect(ref.current).toBe('anon-123')
  })

  it('captureAnonId is a no-op when session is non-anonymous', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeAuthClient(false, 'real-user'))

    expect(ref.current).toBeNull()
  })

  it('captureAnonId is a no-op when session data is null', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeEmptyAuthClient())

    expect(ref.current).toBeNull()
  })

  it('persistForSso writes the anon id to sessionStorage', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))
    analytics.persistForSso()

    expect(sessionStorage.getItem(PENDING_ANON_ID_KEY)).toBe('anon-123')
  })

  it('persistForSso is a no-op when no anon id was captured', () => {
    const analytics = createAnonymousPromotionAnalytics(makeRef())

    analytics.persistForSso()

    expect(sessionStorage.getItem(PENDING_ANON_ID_KEY)).toBeNull()
  })

  it('onPromotionSuccess calls alias and fires trackEvent when anon id was captured', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))
    analytics.onPromotionSuccess('real-user-456')

    expect(mockAlias).toHaveBeenCalledWith('real-user-456', 'anon-123')
    expect(trackEventSpy).toHaveBeenCalledWith('anonymous_user_promoted')
  })

  it('onPromotionSuccess is a no-op when no anon id was captured', () => {
    const analytics = createAnonymousPromotionAnalytics(makeRef())

    analytics.onPromotionSuccess('real-user-456')

    expect(mockAlias).not.toHaveBeenCalled()
    expect(trackEventSpy).not.toHaveBeenCalled()
  })

  it('onPromotionSuccess is a no-op when newUserId equals captured anon id', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeAuthClient(true, 'same-id'))
    analytics.onPromotionSuccess('same-id')

    expect(mockAlias).not.toHaveBeenCalled()
    expect(trackEventSpy).not.toHaveBeenCalled()
  })

  it('clears the captured id after promotion so second call is a no-op', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))
    analytics.onPromotionSuccess('real-user-456')
    analytics.onPromotionSuccess('real-user-456')

    expect(mockAlias).toHaveBeenCalledTimes(1)
    expect(trackEventSpy).toHaveBeenCalledTimes(1)
    expect(ref.current).toBeNull()
  })

  it('captureAnonId is idempotent — same anon id captured twice yields same ref', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref)
    const authClient = makeAuthClient(true, 'anon-123')

    await analytics.captureAnonId(authClient)
    await analytics.captureAnonId(authClient)

    expect(ref.current).toBe('anon-123')
  })
})
