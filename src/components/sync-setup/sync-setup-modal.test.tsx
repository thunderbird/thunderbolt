/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { dispatchMigrationRecoveryKey } from '@/hooks/use-migration-recovery-key'
import { clearAllKeys, generateKeyPair, generateMlKemKeyPair, storeKeyPair } from '@/crypto'
import { clearCachedSession, setCachedSession } from '@/lib/session-cache'
import { createSpyHttpClient } from '@/test-utils/http-client-spy'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import * as setupHook from '@/hooks/use-sync-setup'
import * as encryption from '@/services/encryption'
import { SyncSetupModal } from './sync-setup-modal'

const fireMigration = () => act(() => dispatchMigrationRecoveryKey('word '.repeat(24).trim()))

describe('SyncSetupModal', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    await resetTestDatabase()
    await clearAllKeys()
    clearCachedSession()
    localStorage.removeItem('thunderbolt_device_id')
  })

  const renderModal = (open = true) => {
    const onOpenChange = mock(() => {})
    const onComplete = mock(() => {})
    const TestProvider = createTestProvider()
    render(<SyncSetupModal open={open} onOpenChange={onOpenChange} onComplete={onComplete} />, {
      wrapper: TestProvider,
    })
    return { onOpenChange, onComplete }
  }

  it('stops approval polling when the waiting modal closes', async () => {
    const wrapper = createTestProvider()
    const hook = renderHook(() => setupHook.useSyncSetup(), { wrapper })
    const setup = { ...hook.result.current, step: 'approval-waiting' as const, reset: () => {} }
    hook.unmount()
    const useSetup = spyOn(setupHook, 'useSyncSetup').mockReturnValue(setup)
    const check = spyOn(encryption, 'checkApprovalAndUnwrap').mockResolvedValue(false)
    try {
      const props = { onOpenChange: mock(), onComplete: mock() }
      const view = render(<SyncSetupModal {...props} open />, { wrapper })
      await act(async () => {
        await getClock().tickAsync(6000)
      })
      expect(check).toHaveBeenCalled()
      view.rerender(<SyncSetupModal {...props} open={false} />)
      const calls = check.mock.calls.length
      await act(async () => {
        await getClock().tickAsync(10000)
      })
      expect(check).toHaveBeenCalledTimes(calls)
      view.unmount()
    } finally {
      useSetup.mockRestore()
      check.mockRestore()
    }
  })

  it('stops approval polling on dismissal even when cancellation fails, and resets on reopen', async () => {
    await clearAllKeys()
    const ecdh = await generateKeyPair()
    const mlkem = generateMlKemKeyPair()
    await storeKeyPair(ecdh.privateKey, ecdh.publicKey, mlkem.publicKey, mlkem.secretKey)
    localStorage.setItem('thunderbolt_device_id', 'receiver')
    setCachedSession({ user: { id: 'account-1' } })
    const requests: string[] = []
    const { httpClient } = createSpyHttpClient(async (request) => {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path.endsWith('/devices')) {
        return Response.json({ trusted: false, pendingSince: '2026-11-06T12:00:00Z' })
      }
      if (path.endsWith('/envelope')) {
        return new Response(null, { status: 404 })
      }
      if (path.endsWith('/cancel-pending')) {
        return new Response(null, { status: 409 })
      }
      return Response.json({ scheme_version: 2, passkey_credential_id: null, key_version: 1 })
    })
    const onOpenChange = mock(() => {})
    const onComplete = mock(() => {})
    const view = render(<SyncSetupModal open onOpenChange={onOpenChange} onComplete={onComplete} />, {
      wrapper: createTestProvider({ httpClient }),
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    })
    // Registration and checks include native crypto/IndexedDB work, so fake-time
    // progress alone cannot bound how long they take to finish under load.
    expect(await waitForElement(() => screen.queryByText('Approve this device'))).toBeVisible()
    const pollingStartedAt = performance.now()
    while (
      requests.filter((path) => path.endsWith('/envelope')).length <= 1 &&
      performance.now() - pollingStartedAt < 2000
    ) {
      await act(async () => {
        await getClock().tickAsync(1000)
      })
    }
    const pollsBeforeClose = requests.filter((path) => path.endsWith('/envelope')).length
    expect(pollsBeforeClose).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    view.rerender(<SyncSetupModal open={false} onOpenChange={onOpenChange} onComplete={onComplete} />)
    await act(async () => {
      await getClock().tickAsync(9000)
    })
    expect(requests.filter((path) => path.endsWith('/cancel-pending'))).toHaveLength(1)
    expect(requests.filter((path) => path.endsWith('/envelope'))).toHaveLength(pollsBeforeClose)
    expect(onComplete).not.toHaveBeenCalled()

    view.rerender(<SyncSetupModal open onOpenChange={onOpenChange} onComplete={onComplete} />)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible()
    expect(screen.queryByText('Approve this device')).toBeNull()
    await act(async () => {
      await getClock().tickAsync(3001)
    })
    expect(requests.filter((path) => path.endsWith('/envelope'))).toHaveLength(pollsBeforeClose)
  })

  describe('yielding to the seamless v1→v2 migration', () => {
    it('completes setup rather than just closing', () => {
      // The migration provisioned this device's keys — the wizard's whole success
      // condition. Closing without completing drops the user's request to enable
      // sync, so the toggle they just flipped snaps back off.
      const { onOpenChange, onComplete } = renderModal()

      fireMigration()

      expect(onComplete).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })

    it('ignores the migration while closed', () => {
      const { onOpenChange, onComplete } = renderModal(false)

      fireMigration()

      expect(onComplete).not.toHaveBeenCalled()
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it('completes only once when the migration event fires twice', () => {
      const { onComplete } = renderModal()

      fireMigration()
      fireMigration()

      expect(onComplete).toHaveBeenCalledTimes(1)
    })
  })
})
