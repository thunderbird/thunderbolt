import { AuthProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { DatabaseSingleton } from '@/db/singleton'
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
import { v7 as uuidv7 } from 'uuid'
import Sidebar from './index'

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
    const db = DatabaseSingleton.instance.db

    await db.insert(chatThreadsTable).values([
      { id: threadId1, title: 'First Chat', isEncrypted: 0 },
      { id: threadId2, title: 'Second Chat', isEncrypted: 0 },
    ])

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <HttpClientProvider httpClient={createMockHttpClient([])}>
        <AuthProvider authClient={createMockAuthClient()}>
          <SignInModalProvider>
            <SidebarProvider>{children}</SidebarProvider>
          </SignInModalProvider>
        </AuthProvider>
      </HttpClientProvider>
    )

    const { triggerChange } = renderWithReactivity(<Sidebar />, {
      route: '/chats/new',
      routePath: '/*',
      tables: ['chat_threads'],
      wrapper,
    })

    await waitForElement(() => screen.queryByText('First Chat'))
    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.getByText('Second Chat')).toBeInTheDocument()

    await deleteChatThread(threadId2)
    triggerChange(['chat_threads'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.queryByText('Second Chat')).not.toBeInTheDocument()
  })
})
