/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { createAnonymousPromotionAnalytics, pendingAnonIdKey } from './use-anonymous-promotion-analytics'
import type { trackEvent as defaultTrackEvent } from '@/lib/posthog'
import type { AuthClient } from '@/contexts'

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
  let trackEventMock: ReturnType<typeof mock>
  let aliasMock: ReturnType<typeof mock>
  let trackEvent: typeof defaultTrackEvent
  let alias: (newUserId: string, anonId: string) => void

  beforeEach(() => {
    sessionStorage.clear()
    trackEventMock = mock(() => {})
    aliasMock = mock(() => {})
    trackEvent = trackEventMock as unknown as typeof defaultTrackEvent
    alias = aliasMock as unknown as (newUserId: string, anonId: string) => void
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('captureAnonId stores the id when session is anonymous', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))

    expect(ref.current).toBe('anon-123')
  })

  it('captureAnonId is a no-op when session is non-anonymous', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeAuthClient(false, 'real-user'))

    expect(ref.current).toBeNull()
  })

  it('captureAnonId is a no-op when session data is null', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeEmptyAuthClient())

    expect(ref.current).toBeNull()
  })

  it('persistForSso writes the anon id to sessionStorage', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))
    analytics.persistForSso()

    expect(sessionStorage.getItem(pendingAnonIdKey)).toBe('anon-123')
  })

  it('persistForSso is a no-op when no anon id was captured', () => {
    const analytics = createAnonymousPromotionAnalytics(makeRef(), trackEvent, alias)

    analytics.persistForSso()

    expect(sessionStorage.getItem(pendingAnonIdKey)).toBeNull()
  })

  it('onPromotionSuccess calls alias and fires trackEvent when anon id was captured', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))
    analytics.onPromotionSuccess('real-user-456')

    expect(aliasMock).toHaveBeenCalledWith('real-user-456', 'anon-123')
    expect(trackEventMock).toHaveBeenCalledWith('anonymous_user_promoted')
  })

  it('onPromotionSuccess is a no-op when no anon id was captured', () => {
    const analytics = createAnonymousPromotionAnalytics(makeRef(), trackEvent, alias)

    analytics.onPromotionSuccess('real-user-456')

    expect(aliasMock).not.toHaveBeenCalled()
    expect(trackEventMock).not.toHaveBeenCalled()
  })

  it('onPromotionSuccess is a no-op when newUserId equals captured anon id', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeAuthClient(true, 'same-id'))
    analytics.onPromotionSuccess('same-id')

    expect(aliasMock).not.toHaveBeenCalled()
    expect(trackEventMock).not.toHaveBeenCalled()
  })

  it('clears the captured id after promotion so second call is a no-op', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)

    await analytics.captureAnonId(makeAuthClient(true, 'anon-123'))
    analytics.onPromotionSuccess('real-user-456')
    analytics.onPromotionSuccess('real-user-456')

    expect(aliasMock).toHaveBeenCalledTimes(1)
    expect(trackEventMock).toHaveBeenCalledTimes(1)
    expect(ref.current).toBeNull()
  })

  it('captureAnonId is idempotent — same anon id captured twice yields same ref', async () => {
    const ref = makeRef()
    const analytics = createAnonymousPromotionAnalytics(ref, trackEvent, alias)
    const authClient = makeAuthClient(true, 'anon-123')

    await analytics.captureAnonId(authClient)
    await analytics.captureAnonId(authClient)

    expect(ref.current).toBe('anon-123')
  })
})
