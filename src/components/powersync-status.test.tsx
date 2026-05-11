/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---- module mocks (must come before component import) ----

let mockSession: { user: { id: string; email: string; name: string; isAnonymous?: boolean } } | null = null

mock.module('@/contexts/auth-context', () => ({
  useAuth: () => ({
    useSession: () => ({
      data: mockSession,
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: async () => {},
    }),
  }),
}))

mock.module('@/contexts/sign-in-modal-context', () => ({
  useSignInModal: () => ({ openSignInModal: mock() }),
}))

mock.module('@/hooks/use-powersync-status', () => ({
  usePowerSyncStatus: () => ({ connectionStatus: 'connected', hasSynced: false, lastSyncedAt: null }),
}))

mock.module('@/hooks/use-sync-enabled-toggle', () => ({
  useSyncEnabledToggle: () => ({
    syncEnabled: true,
    syncSetupOpen: false,
    setSyncSetupOpen: mock(),
    handleSyncToggle: mock(),
    handleSyncSetupComplete: mock(),
  }),
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => ({ isMobile: false }),
}))

mock.module('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ setOpenMobile: mock() }),
}))

mock.module('@/db/powersync', () => ({
  reconnectSync: mock(),
}))

mock.module('@/components/sync-setup/sync-setup-modal', () => ({
  SyncSetupModal: () => null,
}))

import { PowerSyncStatus } from './powersync-status'

describe('PowerSyncStatus', () => {
  afterEach(() => {
    cleanup()
    mockSession = null
  })

  describe('anonymous users', () => {
    beforeEach(() => {
      mockSession = { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } }
    })

    it('renders nothing when the session is anonymous', () => {
      const { container } = render(<PowerSyncStatus />)
      expect(container).toBeEmptyDOMElement()
    })

    it('does NOT render the Sync status button for anonymous sessions', () => {
      render(<PowerSyncStatus />)
      expect(screen.queryByLabelText('Sync status')).toBeNull()
    })
  })

  describe('non-anonymous users', () => {
    it('renders the sync status button for an authenticated real user', () => {
      mockSession = { user: { id: 'real-1', email: 'user@example.com', name: 'User', isAnonymous: false } }
      render(<PowerSyncStatus />)
      expect(screen.getByLabelText('Sync status')).toBeInTheDocument()
    })

    it('renders the sync status button when there is no session at all (logged out)', () => {
      mockSession = null
      render(<PowerSyncStatus />)
      expect(screen.getByLabelText('Sync status')).toBeInTheDocument()
    })
  })
})
