/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import 'fake-indexeddb/auto'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as passkeyModule from '@/lib/passkey'
import * as encryptionService from '@/services/encryption'
import { usePasskeyEnrollState } from './use-passkey-enroll-state'

/**
 * Render the hook with an auth client whose passkey endpoints all answer `error`.
 * The device holds no key pair, so session binding is a no-op and the first
 * request is passkey registration.
 */
const renderEnroll = (error: unknown, unlocksSync = true) => {
  const onBusyChange = mock((_isBusy: boolean) => {})
  const onEnrolled = mock(() => {})
  const authClient = createMockAuthClient({ fetch: async () => ({ data: null, error }) })
  const { result } = renderHook(() => usePasskeyEnrollState({ unlocksSync, onEnrolled, onBusyChange }), {
    wrapper: createTestProvider({ authClient }),
  })
  return { result, onBusyChange, onEnrolled }
}

const passkeyRecord: passkeyModule.PasskeyRecord = {
  id: 'pk-1',
  credentialID: 'cred-1',
  createdAt: '2026-10-15T00:00:00.000Z',
  deviceType: 'multiDevice',
  backedUp: true,
}

describe('usePasskeyEnrollState', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    await resetTestDatabase()
    mock.restore()
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

  it('with unlocksSync off, creates a sign-in-only passkey and leaves sync alone', async () => {
    const registerPasskey = spyOn(passkeyModule, 'registerPasskey').mockResolvedValue({
      passkey: passkeyRecord,
      prfOutput: new Uint8Array(32),
    })
    const enrollPasskey = spyOn(encryptionService, 'enrollPasskey')
    const { result, onBusyChange, onEnrolled } = renderEnroll(null, false)

    await act(() => result.current.enroll())

    expect(registerPasskey).toHaveBeenCalledTimes(1)
    expect(enrollPasskey).not.toHaveBeenCalled()
    expect(onEnrolled).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('with unlocksSync off, finishes without registering when the account already has its passkey', async () => {
    spyOn(passkeyModule, 'useAccountPasskey').mockReturnValue({
      passkey: passkeyRecord,
      isUnavailable: false,
      isSettled: true,
      isLoading: false,
      isError: false,
    })
    const registerPasskey = spyOn(passkeyModule, 'registerPasskey')
    const { result, onEnrolled } = renderEnroll(null, false)

    await act(() => result.current.enroll())

    expect(registerPasskey).not.toHaveBeenCalled()
    expect(onEnrolled).toHaveBeenCalledTimes(1)
  })
})
