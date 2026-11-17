/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { renderHook } from '@testing-library/react'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useIsAdmin } from './use-is-admin'

const renderWith = (roles?: string[]) =>
  renderHook(() => useIsAdmin(), {
    wrapper: createTestProvider({
      authClient: createMockAuthClient({ session: { user: { id: 'u1', email: 'u@example.com', roles } } }),
    }),
  }).result.current

describe('useIsAdmin', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)

  it('is true only when the session carries the admin role', () => {
    expect(renderWith(['member', 'admin'])).toBe(true)
    expect(renderWith(['member'])).toBe(false)
    expect(renderWith(undefined)).toBe(false)
  })

  it('is false when signed out', () => {
    const result = renderHook(() => useIsAdmin(), {
      wrapper: createTestProvider({ authClient: createMockAuthClient({ session: null }) }),
    }).result.current
    expect(result).toBe(false)
  })
})
