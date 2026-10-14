/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { usePasskeyEnrollState } from './use-passkey-enroll-state'

/**
 * Render the hook with an auth client whose passkey endpoints all answer `error`.
 * The device holds no key pair, so session binding is a no-op and the first
 * request is passkey registration.
 */
const renderEnroll = (error: unknown) => {
  const onBusyChange = mock((_isBusy: boolean) => {})
  const onEnrolled = mock(() => {})
  const authClient = createMockAuthClient({ fetch: async () => ({ data: null, error }) })
  const { result } = renderHook(() => usePasskeyEnrollState({ onEnrolled, onBusyChange }), {
    wrapper: createTestProvider({ authClient }),
  })
  return { result, onBusyChange, onEnrolled }
}

describe('usePasskeyEnrollState', () => {
  beforeAll(async () => {
    await setupTestDatabase()
    spyOn(console, 'error').mockImplementation(() => {})
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    await resetTestDatabase()
  })

  it('reports busy for the whole enrollment, and idle again after a failure', async () => {
    const { result, onBusyChange, onEnrolled } = renderEnroll({ status: 500, message: 'boom' })

    await act(() => result.current.enroll())

    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
    expect(result.current.status).toBe('error')
    expect(onEnrolled).not.toHaveBeenCalled()
  })

  it('reports idle again when the session needs a fresh sign-in', async () => {
    const { result, onBusyChange } = renderEnroll({ status: 403, code: 'SESSION_NOT_FRESH' })

    await act(() => result.current.enroll())

    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
    expect(result.current.status).toBe('needs-reauth')
  })
})
