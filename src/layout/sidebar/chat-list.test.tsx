/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, mock } from 'bun:test'
import { useRef } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { ChatList } from './chat-list'
import { getClock } from '@/testing-library'
import type { ChatListProps } from './types'

let restoreMeasurement: () => void
beforeAll(async () => {
  restoreMeasurement = mockVirtuaMeasurement()
  await setupTestDatabase()
})
afterEach(() => {
  cleanup()
  localStorage.removeItem('sidebar.recents.expanded')
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

const LocationProbe = () => {
  const location = useLocation()
  return (
    <output aria-label="Location" data-focus-composer={location.state?.focusComposer}>
      {location.pathname + location.search}
    </output>
  )
}

const Fixture = ({
  isMobile,
  isCollapsed = false,
  onChatClick = () => {},
}: {
  isMobile: boolean
  isCollapsed?: boolean
  onChatClick?: ChatListProps['onChatClick']
}) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  return (
    <MemoryRouter initialEntries={['/chats/current?projectId=project-1']}>
      <SidebarProvider>
        <div ref={scrollRef}>
          <ChatList
            sharedScrollRef={scrollRef}
            chatThreads={chats}
            isCollapsed={isCollapsed}
            isMobile={isMobile}
            mobileNavToggle={null}
            mobileSecondaryNavigation={null}
            deleteAllChatsMutation={{ mutate: () => {}, isPending: false } as never}
            deleteChatMutation={{ mutate: () => {}, isPending: false } as never}
            deleteAllChatsDialogRef={{ current: null }}
            deleteChatDialogRef={{ current: null }}
            threadIdRef={{ current: null }}
            onChatClick={onChatClick}
            onRename={() => {}}
            onMoveToProject={() => {}}
            onSearchClick={() => {}}
          />
        </div>
      </SidebarProvider>
      <LocationProbe />
    </MemoryRouter>
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
  expect(screen.queryByRole('button', { name: 'Delete chats' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Delete chats outside projects' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Recents options' })).toBeInTheDocument()

  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Recent chat 10')).toBeVisible()
  expect(screen.queryByText('Recent chat 11')).not.toBeInTheDocument()
})

it('opens the protected burn confirmation by long-pressing Recents without toggling the section', async () => {
  forceMobileViewport()
  render(<Fixture isMobile />, { wrapper: createTestProvider() })
  const section = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
  expect(screen.queryByRole('button', { name: 'Delete chats' })).not.toBeInTheDocument()

  fireEvent.touchStart(section, { touches: [{ clientX: 20, clientY: 20 }] })
  act(() => getClock().tick(500))
  fireEvent.touchEnd(section)
  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'true')

  fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'Delete chats' })))
  const dialog = await waitForElement(() => screen.queryByRole('alertdialog', { name: 'Delete chats?' }))
  expect(dialog).toHaveTextContent("Chats in projects won't be deleted.")
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(dialog).toContainElement(document.activeElement as HTMLElement)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'false')
})

it.each([false, true])(
  'opens Delete chats from the section options without collapsing Recents (mobile: %s)',
  async (isMobile) => {
    if (isMobile) {
      forceMobileViewport()
    }
    render(<Fixture isMobile={isMobile} />, { wrapper: createTestProvider() })
    const section = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
    const options = screen.getByRole('button', { name: 'Recents options' })
    if (isMobile) {
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Recents' }))
    } else {
      fireEvent.keyDown(options, { key: 'Enter' })
    }
    expect(section).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(
      await waitForElement(() => screen.queryByRole(isMobile ? 'button' : 'menuitem', { name: 'Delete chats' })),
    )
    const dialog = await waitForElement(() => screen.queryByRole('alertdialog', { name: 'Delete chats?' }))
    expect(dialog).toHaveTextContent("Chats in projects won't be deleted.")
    await act(async () => {
      await getClock().runAllAsync()
    })
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
  },
)

it.each(['overflow', 'context', 'mobile'])('starts a standalone chat from the Recents %s menu', async (menu) => {
  const isMobile = menu === 'mobile'
  if (isMobile) {
    forceMobileViewport()
  }
  render(<Fixture isMobile={isMobile} />, { wrapper: createTestProvider() })
  const section = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
  if (menu === 'context') {
    fireEvent.contextMenu(section)
  } else {
    const options = screen.getByRole('button', { name: 'Recents options' })
    if (isMobile) {
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Recents' }))
    } else {
      fireEvent.keyDown(options, { key: 'Enter' })
    }
  }
  const surface = await waitForElement(() => screen.queryByRole(isMobile ? 'dialog' : 'menu'))
  const actions = within(surface).getAllByRole(isMobile ? 'button' : 'menuitem')
  expect(actions.map((action) => action.textContent)).toEqual(['New chat', 'Delete chats'])
  await act(async () => {
    fireEvent.click(actions[0])
  })
  expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(/^\/chats\/new$/)
  expect(screen.getByRole('status', { name: 'Location' })).toHaveAttribute('data-focus-composer', 'true')
  expect(section).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByRole(isMobile ? 'dialog' : 'menu')).toBeNull()
})

it('does not open the Recents menu when a touch becomes a scroll', async () => {
  forceMobileViewport()
  render(<Fixture isMobile />, { wrapper: createTestProvider() })
  const section = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
  fireEvent.touchStart(section, { touches: [{ clientX: 20, clientY: 20 }] })
  fireEvent.touchMove(section, { touches: [{ clientX: 20, clientY: 50 }] })
  act(() => getClock().tick(500))
  fireEvent.touchEnd(section)
  expect(screen.queryByRole('button', { name: 'Delete chats' })).not.toBeInTheDocument()
  expect(section).toHaveAttribute('aria-expanded', 'true')
})

it('opens the Recents confirmation by right-clicking the desktop heading', async () => {
  render(<Fixture isMobile={false} />, { wrapper: createTestProvider() })
  const section = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
  fireEvent.contextMenu(section)
  fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Delete chats' })))
  const dialog = await waitForElement(() => screen.queryByRole('alertdialog', { name: 'Delete chats?' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(dialog).toContainElement(document.activeElement as HTMLElement)
  expect(section).toHaveAttribute('aria-expanded', 'true')
})

it('shows one Recents rail button and reveals five chats at a time inside its menu', async () => {
  const onChatClick = mock(() => {})
  render(<Fixture isMobile={false} isCollapsed onChatClick={onChatClick} />, { wrapper: createTestProvider() })
  const trigger = screen.getByRole('button', { name: 'Recents' })
  expect(screen.queryByText('Recent chat 1')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Delete chats outside projects' })).not.toBeInTheDocument()

  fireEvent.keyDown(trigger, { key: 'Enter' })
  await waitForElement(() => screen.queryByRole('menuitem', { name: 'Recent chat 1' }))
  expect(screen.getAllByRole('menuitem', { name: /^Recent chat / })).toHaveLength(5)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show more' }))
  expect(screen.getAllByRole('menuitem', { name: /^Recent chat / })).toHaveLength(10)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Recent chat 9' }))
  expect(onChatClick).toHaveBeenCalledWith('chat-9', null)
  expect(trigger).toHaveAttribute('aria-expanded', 'false')

  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'New chat' })))
  expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent('/chats/new')
  expect(screen.getByRole('status', { name: 'Location' })).not.toHaveTextContent('projectId')
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

it('opens the protected burn confirmation from the Recents menu and keeps focus in the dialog', async () => {
  render(<Fixture isMobile={false} isCollapsed />, { wrapper: createTestProvider() })
  const trigger = screen.getByRole('button', { name: 'Recents' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Delete chats outside projects' })))
  const dialog = await waitForElement(() => screen.queryByRole('alertdialog', { name: 'Delete chats?' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(dialog).toContainElement(document.activeElement as HTMLElement)
})

it('restores Recents expansion after remounting and persists both toggle directions', async () => {
  const first = render(<Fixture isMobile={false} />, { wrapper: createTestProvider() })
  const heading = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
  expect(heading).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(heading)
  expect(localStorage.getItem('sidebar.recents.expanded')).toBe('false')
  first.unmount()
  render(<Fixture isMobile={false} />, { wrapper: createTestProvider() })
  const restored = await waitForElement(() => screen.queryByRole('button', { name: 'Recents' }))
  expect(restored).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(restored)
  expect(restored).toHaveAttribute('aria-expanded', 'true')
  expect(localStorage.getItem('sidebar.recents.expanded')).toBeNull()
})
