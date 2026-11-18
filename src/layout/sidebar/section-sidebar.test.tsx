/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SidebarProvider } from '@/components/ui/sidebar'
import { SignInModalProvider } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Inbox } from 'lucide-react'
import { MemoryRouter } from 'react-router'
import { SectionSidebar, type SectionNavGroup } from './section-sidebar'

const renderWithBadge = (count: number | null) => {
  const groups: SectionNavGroup[] = [
    {
      id: 'queue',
      label: 'Queue' as unknown as SectionNavGroup['label'],
      items: [
        { path: '/queue', label: 'Inbox' as unknown as SectionNavGroup['label'], icon: Inbox, useBadge: () => count },
      ],
    },
  ]
  const TestProvider = createTestProvider({ authClient: createMockAuthClient() })
  return render(
    <TestProvider>
      <SignInModalProvider>
        <MemoryRouter initialEntries={['/queue']}>
          <SidebarProvider>
            <SectionSidebar
              isCollapsed={false}
              activeSection="settings"
              groups={groups}
              onSectionChange={() => {}}
              onNavigate={() => {}}
              footer={null}
            />
          </SidebarProvider>
        </MemoryRouter>
      </SignInModalProvider>
    </TestProvider>,
  )
}

const badge = () => document.querySelector('[data-sidebar="menu-badge"]')

describe('SectionSidebar badge', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it.each([null, 0])('hides the badge for %p', (count) => {
    renderWithBadge(count)
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument()
    expect(badge()).toBeNull()
  })

  it('shows the count', () => {
    renderWithBadge(5)
    expect(badge()).toHaveTextContent(/^5$/)
  })

  it('caps the count at 99+', () => {
    renderWithBadge(150)
    expect(badge()).toHaveTextContent(/^99\+$/)
  })
})
