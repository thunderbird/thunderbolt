/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { useChat as useChat_default } from '@ai-sdk/react'
import { useConfigStore } from '@/api/config-store'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { ChatListItem } from './chat-list-item'
import type { ChatListItemProps } from './types'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
// Import for side effect: registers the framer-motion `mock.module` covering
// every symbol concurrent test files (e.g. skills-view) might also reference.
import '@/test-utils/framer-motion-mock'

// Inject `useChat` via the component's DI seam instead of a global
// `mock.module('@ai-sdk/react')` — module mocks are process-global and leak into
// unrelated files under `--randomize` (see docs/internals/development/testing.md).
const useChatStub = (() => ({ status: 'ready' })) as unknown as typeof useChat_default

const chatListItemWithProviders = (props: ChatListItemProps) => (
  <SidebarProvider>
    <TooltipProvider>
      <ChatListItem {...props} useChat={useChatStub} />
    </TooltipProvider>
  </SidebarProvider>
)

const renderWithProviders = (props: ChatListItemProps) => render(chatListItemWithProviders(props))

const createProps = (overrides?: Partial<ChatListItemProps>): ChatListItemProps => ({
  thread: { id: 'thread-1', title: 'My Chat', isEncrypted: 0, projectId: null, miniAppId: null },
  isActive: false,
  isCollapsed: false,
  isMobile: false,
  deleteChatMutation: { mutate: mock(), isPending: false } as never,
  threadIdRef: { current: null },
  deleteChatDialogRef: { current: { open: mock(), close: mock() } } as never,
  onChatClick: mock(),
  onRename: mock(),
  onMoveToProject: mock(),
  ...overrides,
})

beforeEach(() => {
  useConfigStore.setState({ config: {}, configLoaded: false })
})

afterEach(() => {
  restoreViewport()
  useConfigStore.setState({ config: {}, configLoaded: false })
})

describe('ChatListItem in minimal mode', () => {
  const dragRow = () => document.querySelector('[data-sidebar="menu-item"]')

  it('offers Move to project and a live drag handle by default', async () => {
    renderWithProviders(createProps())
    expect(dragRow()).toHaveAttribute('aria-disabled', 'false')

    fireEvent.contextMenu(screen.getByText('My Chat'))
    await waitForElement(() => screen.queryByText('Rename'))
    expect(screen.getByText('Move to project')).toBeInTheDocument()
  })

  it('drops Move to project from the context menu and disables dragging', async () => {
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: true })
    renderWithProviders(createProps())
    expect(dragRow()).toHaveAttribute('aria-disabled', 'true')

    fireEvent.contextMenu(screen.getByText('My Chat'))
    await waitForElement(() => screen.queryByText('Rename'))
    expect(screen.queryByText('Move to project')).not.toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('drops Move to project from the mobile action sheet', async () => {
    forceMobileViewport()
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: true })
    renderWithProviders(createProps({ isMobile: true }))

    fireEvent.contextMenu(screen.getByText('My Chat'))
    await waitForElement(() => screen.queryByText('Rename'))
    expect(screen.queryByText('Move to project')).not.toBeInTheDocument()
  })
})

describe('ChatListItem', () => {
  it('opens the overflow menu by keyboard without navigating to the chat', async () => {
    const onChatClick = mock()
    renderWithProviders(createProps({ onChatClick }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' })
    expect(await waitForElement(() => screen.queryByText('Rename'))).toBeInTheDocument()
    expect(screen.getByText('Move to project')).toBeInTheDocument()
    expect(onChatClick).not.toHaveBeenCalled()
  })

  it('shows Rename and Delete options in the right-click context menu', async () => {
    renderWithProviders(createProps())
    fireEvent.contextMenu(screen.getByText('My Chat'))
    expect(await waitForElement(() => screen.queryByText('Rename'))).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('keeps the rename input focused after the mobile context menu closes', async () => {
    forceMobileViewport()
    renderWithProviders(createProps({ isMobile: true }))
    fireEvent.contextMenu(screen.getByText('My Chat'))
    const rename = await waitForElement(() => screen.queryByText('Rename'))
    expect(screen.getByText('My Chat', { selector: '[data-slot="drawer-title"]' })).toBeInTheDocument()

    fireEvent.click(rename)
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByRole('textbox', { name: 'Chat name' })).toHaveFocus()
  })

  it('keeps the rename input focused after the desktop context menu closes', async () => {
    renderWithProviders(createProps())
    fireEvent.contextMenu(screen.getByText('My Chat'))
    const rename = await waitForElement(() => screen.queryByText('Rename'))

    fireEvent.click(rename)
    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByRole('textbox', { name: 'Chat name' })).toHaveFocus()
  })

  it('displays the chat title', () => {
    renderWithProviders(createProps())
    expect(screen.getByText('My Chat')).toBeInTheDocument()
  })

  it('shows an optimistic rename until the thread title updates', async () => {
    const onRename = mock()
    const props = createProps({ onRename })
    const view = renderWithProviders(props)
    fireEvent.contextMenu(screen.getByText('My Chat'))
    fireEvent.click(await waitForElement(() => screen.queryByText('Rename')))
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat name' }), { target: { value: 'Renamed Chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onRename).toHaveBeenCalledWith('thread-1', 'Renamed Chat')
    expect(screen.getByText('Renamed Chat')).toBeInTheDocument()

    view.rerender(
      chatListItemWithProviders({
        ...props,
        thread: { ...props.thread, title: 'Server Title' },
      }),
    )
    expect(screen.getByText('Server Title')).toBeInTheDocument()
  })

  it('hides the overflow menu on mobile', () => {
    forceMobileViewport()
    const { container } = renderWithProviders(createProps({ isMobile: true }))
    expect(container.querySelector('[data-slot="dropdown-menu-trigger"]')).toBeNull()
  })

  it('navigates when clicking the chat item', () => {
    const onChatClick = mock()
    renderWithProviders(createProps({ onChatClick }))
    fireEvent.click(screen.getByText('My Chat'))
    // The row passes its own `miniAppId` up, so the sidebar doesn't have to
    // find the thread again to learn where the click should land.
    expect(onChatClick).toHaveBeenCalledWith('thread-1', null)
  })

  it('renders icon-only view when collapsed', () => {
    renderWithProviders(createProps({ isCollapsed: true }))
    expect(screen.queryByText('My Chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Rename')).not.toBeInTheDocument()
  })
})
