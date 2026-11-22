/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { SidebarProvider } from '@/components/ui/sidebar'
import { SignInModalProvider } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { AdminSidebar } from './admin-sidebar'

const adminSession = { user: { id: 'admin-1', email: 'admin@example.com', name: 'Admin', roles: ['member', 'admin'] } }

const renderSidebar = (path: string, onNavigate: (path: string) => void = () => {}) => {
  const TestProvider = createTestProvider({ authClient: createMockAuthClient({ session: adminSession }) })
  return render(
    <TestProvider>
      <SignInModalProvider>
        <MemoryRouter initialEntries={[path]}>
          <SidebarProvider>
            <AdminSidebar isCollapsed={false} onSectionChange={() => {}} onNavigate={onNavigate} footer={null} />
          </SidebarProvider>
        </MemoryRouter>
      </SignInModalProvider>
    </TestProvider>,
  )
}

describe('AdminSidebar', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('lists every admin screen and navigates to it', () => {
    const onNavigate = mock((_path: string) => {})
    renderSidebar('/admin/members', onNavigate)

    for (const label of ['Members', 'Groups', 'Sign-in methods', 'Link reviews', 'Audit log']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Audit log' }))
    expect(onNavigate).toHaveBeenCalledWith('/admin/audit-log')
  })

  it('marks the current screen', () => {
    renderSidebar('/admin/sign-in-methods')
    expect(screen.getByRole('button', { name: 'Sign-in methods' })).toHaveAttribute('data-active', 'true')
  })
})
