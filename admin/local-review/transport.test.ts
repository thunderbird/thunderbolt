/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { localReviewFetch } from './transport'

describe('local review transport', () => {
  it('provides a sample session without issuing a usable authentication token', async () => {
    const response = await localReviewFetch('http://localhost:1426/__local_review__/v1/api/auth/get-session')
    const body = await response.json()
    expect(body.user.email).toBe('avery@example.com')
    expect(body.session.token).toBe('')
    expect(response.headers.has('set-auth-token')).toBe(false)
  })
  it('rejects writes and external operations locally instead of forwarding them', async () => {
    const response = await localReviewFetch('https://example.com/v1/config', { method: 'POST' })
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('LOCAL_REVIEW_ONLY')
  })
})
