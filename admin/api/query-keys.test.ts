/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { describe, expect, it } from 'bun:test'
import { adminQueryKeys } from './query-keys'

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, index) => key[index] === part)

describe('adminQueryKeys', () => {
  it('puts every list under its area, so invalidating the area refreshes it', () => {
    expect(
      startsWith(adminQueryKeys.auditEvents.list({ action: 'scim.request' }), adminQueryKeys.auditEvents.all),
    ).toBe(true)
    expect(
      startsWith(adminQueryKeys.linkReviews.list({ status: 'pending', limit: 100 }), adminQueryKeys.linkReviews.all),
    ).toBe(true)
    expect(startsWith(adminQueryKeys.members.detail('u1'), adminQueryKeys.all)).toBe(true)
  })

  it('keys a list on its whole query', () => {
    expect(adminQueryKeys.linkReviews.list({ status: 'pending', limit: 100 })).not.toEqual(
      adminQueryKeys.linkReviews.list({ status: 'pending' }),
    )
  })
})
