/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { dispatchMigrationRecoveryKey } from '@/hooks/use-migration-recovery-key'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
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
    await resetTestDatabase()
    cleanup()
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
