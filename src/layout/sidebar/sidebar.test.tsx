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
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import Sidebar from './index'
import type { ReactNode } from 'react'

describe('Sidebar reactivity', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('updates when chat_threads table changes', async () => {
    const threadId1 = uuidv7()
    const threadId2 = uuidv7()
    const db = getDb()

    await db.insert(chatThreadsTable).values([
      { id: threadId1, title: 'First Chat', isEncrypted: 0 },
      { id: threadId2, title: 'Second Chat', isEncrypted: 0 },
    ])

    const wrapper = ({ children }: { children: ReactNode }) => (
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

    const { triggerChange } = renderWithReactivity(<Sidebar />, {
      tables: ['chat_threads'],
      wrapper,
    })

    await waitForElement(() => screen.queryByText('First Chat'))
    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.getByText('Second Chat')).toBeInTheDocument()

    await deleteChatThread(db, threadId2)
    triggerChange(['chat_threads'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.queryByText('Second Chat')).not.toBeInTheDocument()
  })
})
