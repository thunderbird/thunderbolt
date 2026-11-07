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
  const { result, unmount } = renderHook(() => usePasskeyEnrollState({ unlocksSync, onEnrolled, onBusyChange }), {
    wrapper: createTestProvider({ authClient }),
  })
  return { result, unmount, onBusyChange, onEnrolled }
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

  it('admits one enrollment and stops before opening a second prompt after unmount', async () => {
    const registration = Promise.withResolvers<Awaited<ReturnType<typeof passkeyModule.registerPasskey>>>()
    const register = spyOn(passkeyModule, 'registerPasskey').mockReturnValue(registration.promise)
    const prf = spyOn(passkeyModule, 'getPasskeyPrfOutput')
    const enroll = spyOn(encryptionService, 'enrollPasskey')
    spyOn(encryptionService, 'ensureSessionBound').mockResolvedValue()
    const { result, unmount, onBusyChange, onEnrolled } = renderEnroll(null)
    let first!: Promise<void>
    await act(async () => {
      first = result.current.enroll()
      void result.current.enroll()
    })
    expect(register).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls).toEqual([[true]])
    unmount()
    registration.resolve({ passkey: passkeyRecord, prfOutput: null })
    await first
    expect(prf).not.toHaveBeenCalled()
    expect(enroll).not.toHaveBeenCalled()
    expect(onEnrolled).not.toHaveBeenCalled()
    expect(onBusyChange.mock.calls).toEqual([[true]])
  })

  it.each([true, false])('enrolls sync with a PRF assertion (existing passkey: %s)', async (existing) => {
    spyOn(passkeyModule, 'useAccountPasskey').mockReturnValue({
      passkey: existing ? passkeyRecord : null,
      isUnavailable: false,
      isSettled: true,
      isLoading: false,
      isError: false,
    })
    const register = spyOn(passkeyModule, 'registerPasskey').mockResolvedValue({
      passkey: passkeyRecord,
      prfOutput: null,
    })
    const output = new Uint8Array(32)
    const prf = spyOn(passkeyModule, 'getPasskeyPrfOutput').mockResolvedValue(output)
    const enroll = spyOn(encryptionService, 'enrollPasskey').mockResolvedValue()
    spyOn(encryptionService, 'ensureSessionBound').mockResolvedValue()
    const { result, onEnrolled, onBusyChange } = renderEnroll(null)
    await act(() => result.current.enroll())
    expect(register).toHaveBeenCalledTimes(existing ? 0 : 1)
    expect(prf).toHaveBeenCalledWith(passkeyRecord.credentialID)
    expect(enroll).toHaveBeenCalledWith(expect.anything(), {
      credentialId: passkeyRecord.credentialID,
      prfOutput: output,
    })
    expect(onEnrolled).toHaveBeenCalledTimes(1)
    expect(onBusyChange.mock.calls).toEqual([[true], [false]])
  })

  it('keeps a sign-in passkey when its provider cannot return a PRF', async () => {
    spyOn(passkeyModule, 'useAccountPasskey').mockReturnValue({
      passkey: passkeyRecord,
      isUnavailable: false,
      isSettled: true,
      isLoading: false,
      isError: false,
    })
    spyOn(passkeyModule, 'getPasskeyPrfOutput').mockResolvedValue(null)
    spyOn(encryptionService, 'ensureSessionBound').mockResolvedValue()
    const enroll = spyOn(encryptionService, 'enrollPasskey')
    const { result, onEnrolled } = renderEnroll(null)
    await act(() => result.current.enroll())
    expect(result.current.status).toBe('no-prf')
    expect(enroll).not.toHaveBeenCalled()
    expect(onEnrolled).not.toHaveBeenCalled()
  })

  it('returns to idle after a dismissed prompt', async () => {
    spyOn(passkeyModule, 'registerPasskey').mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'))
    const { result } = renderEnroll(null, false)
    await act(() => result.current.enroll())
    expect(result.current.status).toBe('idle')
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
    act(() => result.current.onReauthenticated())
    expect(result.current.status).toBe('idle')
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
