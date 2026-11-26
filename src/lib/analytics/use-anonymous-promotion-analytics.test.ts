/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createAnonymousPromotionAnalytics, pendingPromotionKey } from './use-anonymous-promotion-analytics'
import { consumePendingSsoPromotion } from './anonymous-promotion-sso-bridge'
import type { AuthClient } from '@/contexts'
import type { EventType } from '@/lib/posthog'

const makeAuthClient = (isAnonymous?: boolean, id = 'real-account-id') =>
  ({
    getSession: mock(async () => ({ data: isAnonymous === undefined ? null : { user: { id, isAnonymous } } })),
  }) as unknown as AuthClient

beforeEach(() => sessionStorage.clear())
afterEach(() => sessionStorage.clear())

describe('account-independent promotion analytics', () => {
  it('records an OTP promotion once without either account ID', async () => {
    const trackEvent = mock((_event: EventType) => {})
    const wasAnonymous = { current: false }
    const analytics = createAnonymousPromotionAnalytics(wasAnonymous, trackEvent)
    await analytics.captureAnonymousSession(makeAuthClient(true, 'anonymous-account-id'))
    expect(wasAnonymous.current).toBe(true)

    analytics.onPromotionSuccess()
    analytics.onPromotionSuccess()

    expect(trackEvent.mock.calls).toEqual([['anonymous_user_promoted']])
    expect(wasAnonymous.current).toBe(false)
    expect(sessionStorage.length).toBe(0)
  })

  it.each([undefined, false])('does not record a promotion for a non-anonymous session (%s)', async (anonymous) => {
    const trackEvent = mock((_event: EventType) => {})
    const analytics = createAnonymousPromotionAnalytics({ current: true }, trackEvent)
    await analytics.captureAnonymousSession(makeAuthClient(anonymous))
    analytics.onPromotionSuccess()
    analytics.persistForSso()
    expect(trackEvent).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(pendingPromotionKey)).toBeNull()
  })

  it('uses a resolved signed-out snapshot without another session fetch', async () => {
    const authClient = makeAuthClient(true)
    const wasAnonymous = { current: true }
    const analytics = createAnonymousPromotionAnalytics(wasAnonymous)
    await analytics.captureAnonymousSession(authClient, null)
    expect(authClient.getSession).not.toHaveBeenCalled()
    expect(wasAnonymous.current).toBe(false)
  })

  it('does not block sign-in when the optional analytics session lookup fails', async () => {
    const trackEvent = mock((_event: EventType) => {})
    const wasAnonymous = { current: true }
    const analytics = createAnonymousPromotionAnalytics(wasAnonymous, trackEvent)
    const authClient = {
      getSession: async () => {
        throw new Error('offline')
      },
    } as unknown as AuthClient
    await expect(analytics.captureAnonymousSession(authClient)).resolves.toBeUndefined()
    analytics.onPromotionSuccess()
    expect(wasAnonymous.current).toBe(false)
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('persists only a boolean through SSO and consumes it once after sign-in', async () => {
    const trackEvent = mock((_event: EventType) => {})
    const analytics = createAnonymousPromotionAnalytics({ current: false }, trackEvent)
    const anonymousSession = { user: { id: 'anonymous-account-id', isAnonymous: true } }
    await analytics.captureAnonymousSession(makeAuthClient(false), anonymousSession)
    analytics.persistForSso()
    expect(sessionStorage.getItem(pendingPromotionKey)).toBe('1')
    expect(JSON.stringify(sessionStorage)).not.toContain('anonymous-account-id')

    const authClient = makeAuthClient(false, 'signed-in-account-id')
    await Promise.all([
      consumePendingSsoPromotion(authClient, trackEvent),
      consumePendingSsoPromotion(authClient, trackEvent),
    ])
    expect(trackEvent.mock.calls).toEqual([['anonymous_user_promoted']])
    expect(authClient.getSession).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(pendingPromotionKey)).toBeNull()
  })

  it.each([undefined, true])('does not record a failed SSO conversion (%s)', async (anonymous) => {
    sessionStorage.setItem(pendingPromotionKey, '1')
    const trackEvent = mock((_event: EventType) => {})
    await consumePendingSsoPromotion(makeAuthClient(anonymous), trackEvent)
    expect(trackEvent).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(pendingPromotionKey)).toBeNull()
  })

  it('discards legacy account IDs without aliasing or querying the session', async () => {
    sessionStorage.setItem('thunderbolt_pending_anon_id', 'legacy-account-id')
    const authClient = makeAuthClient(false)
    const trackEvent = mock((_event: EventType) => {})
    await consumePendingSsoPromotion(authClient, trackEvent)
    expect(sessionStorage.getItem('thunderbolt_pending_anon_id')).toBeNull()
    expect(authClient.getSession).not.toHaveBeenCalled()
    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('clears stale SSO conversion markers when the next sign-in is not anonymous', async () => {
    sessionStorage.setItem(pendingPromotionKey, '1')
    const analytics = createAnonymousPromotionAnalytics({ current: false })
    analytics.persistForSso()
    expect(sessionStorage.getItem(pendingPromotionKey)).toBeNull()
  })
})
