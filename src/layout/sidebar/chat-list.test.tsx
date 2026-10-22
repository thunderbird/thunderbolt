/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { useRef } from 'react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { ChatList } from './chat-list'

let restoreMeasurement: () => void
beforeAll(async () => {
  restoreMeasurement = mockVirtuaMeasurement()
  await setupTestDatabase()
})
afterEach(() => {
  cleanup()
  restoreViewport()
})
afterAll(async () => {
  restoreMeasurement()
  await teardownTestDatabase()
})

const chats = Array.from({ length: 12 }, (_, index) => ({
  id: `chat-${index + 1}`,
  title: `Recent chat ${index + 1}`,
  projectId: null,
  miniAppId: null,
  isEncrypted: 0,
}))

const Fixture = ({ isMobile }: { isMobile: boolean }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <SidebarProvider>
      <div ref={scrollRef}>
        <ChatList
          sharedScrollRef={scrollRef}
          chatThreads={chats}
          isCollapsed={false}
          isMobile={isMobile}
          mobileNavToggle={null}
          mobileSecondaryNavigation={null}
          deleteAllChatsMutation={{ mutate: () => {}, isPending: false } as never}
          deleteChatMutation={{ mutate: () => {}, isPending: false } as never}
          deleteAllChatsDialogRef={{ current: null }}
          deleteChatDialogRef={{ current: null }}
          threadIdRef={{ current: null }}
          onChatClick={() => {}}
          onRename={() => {}}
          onMoveToProject={() => {}}
          onSearchClick={() => {}}
        />
      </div>
    </SidebarProvider>
  )
}

it.each([false, true])('collapses Recents and restores its expanded preview (mobile: %s)', async (isMobile) => {
  if (isMobile) {
    forceMobileViewport()
  }
  render(<Fixture isMobile={isMobile} />, { wrapper: createTestProvider() })
  await waitForElement(() => screen.queryByText('Recent chat 1'))
  const section = screen.getByRole('button', { name: 'Recents' })
  expect(section).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByText('Recent chat 6')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Show more recent chats' }))
  expect(await waitForElement(() => screen.queryByText('Recent chat 10'))).toBeVisible()

  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryAllByRole('button', { name: 'Recent chat 1' })).toHaveLength(0)
  expect(screen.queryByRole('button', { name: 'Show more recent chats' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Delete chats outside projects' })).toBeVisible()

  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Recent chat 10')).toBeVisible()
  expect(screen.queryByText('Recent chat 11')).not.toBeInTheDocument()
})
