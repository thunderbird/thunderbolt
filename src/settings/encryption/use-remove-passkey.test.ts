/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, cleanup, renderHook } from '@testing-library/react'
import * as passkeys from '@/lib/passkey'
import * as readiness from '@/hooks/use-e2ee-ready'
import { removeAccountPasskey, useRemovePasskey } from './use-remove-passkey'

const recordingSteps = (holdsSlot: boolean, e2eeReady = true) => {
  const calls: string[] = []
  return {
    calls,
    steps: {
      holdsSyncSlot: async () => holdsSlot,
      removeSyncSlot: async () => {
        calls.push('remove-slot')
      },
      deletePasskey: async () => {
        calls.push('delete-passkey')
      },
      e2eeReady,
    },
  }
}

describe('removeAccountPasskey', () => {
  it('does not begin a slot rotation when the metadata response belongs to a cancelled flow', async () => {
    const { calls, steps } = recordingSteps(true)
    expect(await removeAccountPasskey({ ...steps, isCurrent: () => false })).toBe('cancelled')
    expect(calls).toEqual([])
  })

  it('stops after a committed slot removal if the flow ends before deleting the sign-in passkey', async () => {
    const { calls, steps } = recordingSteps(true)
    let active = true
    expect(
      await removeAccountPasskey({
        ...steps,
        isCurrent: () => active,
        removeSyncSlot: async () => {
          calls.push('remove-slot')
          active = false
        },
      }),
    ).toBe('cancelled')
    expect(calls).toEqual(['remove-slot'])
  })

  it('drops the sync slot before deleting the passkey', async () => {
    const { calls, steps } = recordingSteps(true)
    expect(await removeAccountPasskey(steps)).toBe('removed')
    expect(calls).toEqual(['remove-slot', 'delete-passkey'])
  })

  it('deletes a passkey that holds no slot without rotating', async () => {
    const { calls, steps } = recordingSteps(false)
    expect(await removeAccountPasskey(steps)).toBe('removed')
    expect(calls).toEqual(['delete-passkey'])
  })

  it('touches nothing when the slot needs a rotation this device cannot run', async () => {
    const { calls, steps } = recordingSteps(true, false)
    expect(await removeAccountPasskey(steps)).toBe('needs-sync')
    expect(calls).toEqual([])
  })

  it('does not delete the passkey when the slot rotation fails', async () => {
    const { calls, steps } = recordingSteps(true)
    const failing = {
      ...steps,
      removeSyncSlot: async () => {
        throw new Error('rotation failed')
      },
    }
    await expect(removeAccountPasskey(failing)).rejects.toThrow('rotation failed')
    expect(calls).toEqual([])
  })
})

describe('useRemovePasskey', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(async () => {
    cleanup()
    mock.restore()
    await resetTestDatabase()
  })

  it('admits one removal and ignores a stale failure after cancel and reopen', async () => {
    spyOn(readiness, 'useE2eeReady').mockReturnValue(false)
    const pending = Promise.withResolvers<void>()
    const remove = spyOn(passkeys, 'deletePasskey').mockReturnValue(pending.promise)
    const passkey: passkeys.PasskeyRecord = {
      id: 'passkey',
      credentialID: 'credential',
      createdAt: '2026-10-15T00:00:00.000Z',
      deviceType: 'multiDevice',
      backedUp: true,
    }
    const { result } = renderHook(() => useRemovePasskey(passkey), {
      wrapper: createTestProvider({ mockResponse: { passkey_credential_id: null } }),
    })
    let first!: Promise<void>
    await act(async () => {
      first = result.current.remove()
      void result.current.remove()
    })
    expect(remove).toHaveBeenCalledTimes(1)
    act(() => {
      result.current.cancel()
      result.current.openConfirm()
    })
    await act(async () => {
      pending.reject(new Error('old failure'))
      await first
    })
    expect(result.current.status).toBe('confirming')
    expect(result.current.error).toBeNull()
  })
})
