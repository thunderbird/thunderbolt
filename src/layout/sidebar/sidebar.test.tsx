/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthProvider, DatabaseProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { deleteChatThread } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { SidebarProvider } from '@/components/ui/sidebar'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import Sidebar from './index'
import type { ReactNode } from 'react'

const SidebarTestWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>
    <HttpClientProvider httpClient={createMockHttpClient([])}>
      <AuthProvider authClient={createMockAuthClient()}>
        <SignInModalProvider>
          <MemoryRouter initialEntries={['/chats/new']}>
            <SidebarProvider>
              <Routes>
                <Route path="/*" element={children} />
              </Routes>
            </SidebarProvider>
          </MemoryRouter>
        </SignInModalProvider>
      </AuthProvider>
    </HttpClientProvider>
  </DatabaseProvider>
)

describe('Sidebar reactivity', () => {
  // The chat list is virtualized (virtua) — give it real-looking measurements
  // or it renders zero rows in happy-dom.
  let restoreVirtuaMeasurement: () => void

  beforeAll(async () => {
    restoreVirtuaMeasurement = mockVirtuaMeasurement()
    await setupTestDatabase()
  })

  afterAll(async () => {
    restoreVirtuaMeasurement()
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  it('updates when chat_threads table changes', async () => {
    const threadId1 = uuidv7()
    const threadId2 = uuidv7()
    const db = getDb()

    await db.insert(chatThreadsTable).values([
      { id: threadId1, title: 'First Chat', isEncrypted: 0 },
      { id: threadId2, title: 'Second Chat', isEncrypted: 0 },
    ])

    const { triggerChange } = renderWithReactivity(<Sidebar />, {
      tables: ['chat_threads'],
      wrapper: SidebarTestWrapper,
    })

    await waitForElement(() => screen.queryByText('First Chat'))
    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.getByText('Second Chat')).toBeInTheDocument()
    expect(screen.getByText('First Chat').closest('li')?.firstElementChild).toHaveClass('pb-1')

    await deleteChatThread(db, threadId2)
    triggerChange(['chat_threads'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.queryByText('Second Chat')).not.toBeInTheDocument()
  })

  it('scrolls the mobile label beneath masked header and footer scrims', async () => {
    forceMobileViewport()
    const db = getDb()

    await db.insert(chatThreadsTable).values({
      id: uuidv7(),
      title: 'Mobile Chat',
      isEncrypted: 0,
    })

    renderWithReactivity(<Sidebar />, {
      tables: ['chat_threads'],
      wrapper: SidebarTestWrapper,
    })

    await waitForElement(() => screen.queryByText('Mobile Chat'))

    const scrollArea = document.querySelector<HTMLElement>('[data-slot="chat-list-scroll"]')
    const mobileHeader = document.querySelector<HTMLElement>('[data-slot="mobile-sidebar-header"]')
    const recentChatsLabel = screen.getByText('Recent Chats')
    const sidebarFooter = document.querySelector<HTMLElement>('[data-sidebar="footer"]')

    expect(scrollArea).toContainElement(recentChatsLabel)
    expect(mobileHeader).not.toContainElement(recentChatsLabel)
    expect(scrollArea).not.toContainElement(mobileHeader)
    expect(mobileHeader).toHaveClass('absolute', 'pt-[calc(var(--header-safe-area-top)+0.5rem)]')
    expect(scrollArea).toHaveClass('pb-[calc(var(--touch-height-lg)+0.5rem+var(--mobile-sidebar-footer-inset))]')
    expect(scrollArea).not.toHaveClass('overscroll-y-none')
    expect(scrollArea?.querySelector('[data-slot="mobile-sidebar-header-spacer"]')).toBeInTheDocument()
    expect(sidebarFooter).toHaveClass('pb-[var(--mobile-sidebar-footer-inset)]')
    expect(document.querySelector('[data-slot="mobile-sidebar-header-scrim"]')).toHaveClass(
      'from-sidebar',
      'backdrop-blur-[4px]',
    )
    expect(document.querySelector('[data-slot="mobile-sidebar-footer-scrim"]')).toHaveClass(
      'from-sidebar',
      'backdrop-blur-[4px]',
    )
    expect(scrollArea?.className).not.toContain('shadow-[')
    expect(sidebarFooter?.className).not.toContain('shadow-[')
  })
})
