/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type ComponentProps, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

// ---- module mocks (must come before component import) ----

let mockSession: { user: { id: string; email: string; name: string; isAnonymous?: boolean } } | null = null
let mockIsPending = false

mock.module('@/contexts', () => ({
  useAuth: () => ({
    useSession: () => ({
      data: mockSession,
      isPending: mockIsPending,
      isRefetching: false,
      error: null,
      refetch: async () => {},
    }),
  }),
  useSignInModal: () => ({ openSignInModal: mock() }),
}))

mock.module('@/hooks/use-settings', () => ({
  useSettings: () => ({ preferredName: { value: '' } }),
}))

mock.module('@/lib/platform', () => ({
  isTauri: () => false,
  isWebDesktopPlatform: () => false,
}))

mock.module('@/components/ui/sidebar', () => {
  const passthrough = ({ children }: { children: ReactNode }) => <>{children}</>
  return {
    SidebarFooter: passthrough,
    SidebarMenu: passthrough,
    SidebarMenuButton: ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>,
    SidebarMenuItem: passthrough,
    useSidebar: () => ({ isMobile: false, setOpenMobile: mock(), state: 'expanded' }),
  }
})

mock.module('@/components/logout-modal', () => ({
  LogoutModal: () => null,
}))

import { SidebarFooter } from './sidebar-footer'

const renderFooter = () =>
  render(
    <MemoryRouter>
      <SidebarFooter />
    </MemoryRouter>,
  )

describe('SidebarFooter', () => {
  afterEach(() => {
    cleanup()
    mockSession = null
    mockIsPending = false
  })

  describe('anonymous users', () => {
    beforeEach(() => {
      mockSession = { user: { id: 'anon-1', email: 'temp@anon.com', name: 'Anonymous', isAnonymous: true } }
    })

    it('shows the Sign In affordance and treats the session as logged-out', () => {
      renderFooter()
      expect(screen.getByText('Sign In')).toBeInTheDocument()
    })

    it('does NOT leak the synthetic anonymous email into the UI', () => {
      renderFooter()
      expect(screen.queryByText('temp@anon.com')).toBeNull()
    })

    it('does NOT show "Anonymous" as a logged-in display name', () => {
      renderFooter()
      expect(screen.queryByText('Anonymous')).toBeNull()
    })
  })

  describe('real authenticated users', () => {
    it('shows the user email and not the Sign In affordance', () => {
      mockSession = { user: { id: 'real-1', email: 'user@example.com', name: 'Real User', isAnonymous: false } }
      renderFooter()
      expect(screen.getByText('user@example.com')).toBeInTheDocument()
      expect(screen.queryByText('Sign In')).toBeNull()
    })
  })

  describe('fully logged-out users', () => {
    it('shows the Sign In affordance', () => {
      mockSession = null
      renderFooter()
      expect(screen.getByText('Sign In')).toBeInTheDocument()
    })
  })

  describe('pending session', () => {
    it('shows the loading indicator', () => {
      mockSession = null
      mockIsPending = true
      renderFooter()
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })
  })
})
