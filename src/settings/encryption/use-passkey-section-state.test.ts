/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as e2eeReadyModule from '@/hooks/use-e2ee-ready'
import * as passkeyModule from '@/lib/passkey'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { usePasskeySectionState } from './use-passkey-section-state'

const passkeyRecord: passkeyModule.PasskeyRecord = {
  id: 'pk-1',
  credentialID: 'cred-1',
  createdAt: '2026-10-15T00:00:00.000Z',
  deviceType: 'multiDevice',
  backedUp: true,
}

type AccountPasskey = ReturnType<typeof passkeyModule.useAccountPasskey>

const settled: AccountPasskey = {
  passkey: null,
  isUnavailable: false,
  isSettled: true,
  isLoading: false,
  isError: false,
}

/** Render the hook with passkeys `available` and the account lookup in `account`. */
const renderSection = (account: Partial<AccountPasskey>, available = true) => {
  spyOn(passkeyModule, 'usePasskeyAvailable').mockReturnValue(available)
  spyOn(passkeyModule, 'useAccountPasskey').mockReturnValue({ ...settled, ...account })
  return renderHook(() => usePasskeySectionState())
}

describe('usePasskeySectionState', () => {
  afterEach(() => {
    mock.restore()
  })

  it('shows the account passkey when it has one', () => {
    const { result } = renderSection({ passkey: passkeyRecord })
    expect(result.current.row).toEqual({ kind: 'passkey', passkey: passkeyRecord })
  })

  it('offers Add when the account has none', () => {
    const { result } = renderSection({})
    expect(result.current.row).toEqual({ kind: 'add' })
  })

  it('shows nothing while unavailable, loading, or after a failed lookup', () => {
    expect(renderSection({}, false).result.current.row).toEqual({ kind: 'hidden' })
    expect(renderSection({ isLoading: true, isSettled: false }).result.current.row).toEqual({ kind: 'hidden' })
    expect(renderSection({ isError: true }).result.current.row).toEqual({ kind: 'hidden' })
  })

  it('keeps the Add dialog open when a failed refresh hides the row mid-enrollment', async () => {
    spyOn(e2eeReadyModule, 'isE2eeReady').mockResolvedValue(true)
    spyOn(passkeyModule, 'usePasskeyAvailable').mockReturnValue(true)
    const accountPasskey = spyOn(passkeyModule, 'useAccountPasskey').mockReturnValue(settled)
    const { result, rerender } = renderHook(() => usePasskeySectionState())

    await act(() => result.current.openAddDialog())
    accountPasskey.mockReturnValue({ ...settled, isError: true })
    rerender()

    expect(result.current.row).toEqual({ kind: 'hidden' })
    expect(result.current.isAddDialogOpen).toBe(true)
  })

  it('unlocks sync only when this device holds the sync keys at the tap', async () => {
    const isE2eeReady = spyOn(e2eeReadyModule, 'isE2eeReady').mockResolvedValue(true)
    const { result } = renderSection({})

    await act(() => result.current.openAddDialog())
    expect(result.current.unlocksSync).toBe(true)

    isE2eeReady.mockResolvedValue(false)
    await act(() => result.current.openAddDialog())
    expect(result.current.unlocksSync).toBe(false)
  })

  it('treats an unreadable key store as no sync keys', async () => {
    spyOn(e2eeReadyModule, 'isE2eeReady').mockRejectedValue(new Error('IndexedDB blocked'))
    const { result } = renderSection({})

    await act(() => result.current.openAddDialog())

    expect(result.current.unlocksSync).toBe(false)
    expect(result.current.isAddDialogOpen).toBe(true)
  })
})
