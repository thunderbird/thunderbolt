/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { useConfigStore } from '@/api/config-store'
import { CreateItemProvider } from '@/components/create-item/context'
import { SidebarProvider } from '@/components/ui/sidebar'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { AdminRoute } from './admin-route'
import { SectionLayout } from './section-layout'

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>

/** The admin branch of the app's route table. */
const renderAt = (path: string, options: { roles?: string[]; isPending?: boolean } = {}) => {
  const session = options.isPending ? null : { user: { id: 'u1', email: 'u@example.com', roles: options.roles } }
  const TestProvider = createTestProvider({
    authClient: createMockAuthClient({ session, isPending: options.isPending }),
  })
  return render(
    <TestProvider>
      <SidebarProvider>
        <CreateItemProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/chats/new" element={<LocationProbe />} />
              <Route element={<AdminRoute />}>
                <Route path="admin" element={<SectionLayout />}>
                  <Route path="*" element={<div>Admin screens</div>} />
                </Route>
              </Route>
            </Routes>
          </MemoryRouter>
        </CreateItemProvider>
      </SidebarProvider>
    </TestProvider>,
  )
}

describe('AdminRoute', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(() => {
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  afterEach(() => {
    cleanup()
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  it('shows the admin screens to an admin', () => {
    renderAt('/admin/members', { roles: ['member', 'admin'] })
    expect(screen.getByText('Admin screens')).toBeInTheDocument()
  })

  it('sends a non-admin to the chat home', () => {
    renderAt('/admin/members', { roles: ['member'] })
    expect(screen.getByTestId('location')).toHaveTextContent('/chats/new')
    expect(screen.queryByText('Admin screens')).not.toBeInTheDocument()
  })

  it('waits for the first session read instead of redirecting', () => {
    renderAt('/admin/members', { isPending: true })
    expect(screen.queryByTestId('location')).not.toBeInTheDocument()
    expect(screen.queryByText('Admin screens')).not.toBeInTheDocument()
  })

  it('keeps an admin in, unlike Settings, in minimal mode', () => {
    useConfigStore.setState({ config: { minimalMode: true } })
    renderAt('/admin/members', { roles: ['member', 'admin'] })
    expect(screen.getByText('Admin screens')).toBeInTheDocument()
  })
})
