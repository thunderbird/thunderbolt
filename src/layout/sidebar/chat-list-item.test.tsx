/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { useChat as useChat_default } from '@ai-sdk/react'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { ChatListItem } from './chat-list-item'
import type { ChatListItemProps } from './types'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
// Import for side effect: registers the framer-motion `mock.module` covering
// every symbol concurrent test files (e.g. skills-view) might also reference.
import '@/test-utils/framer-motion-mock'

// Inject `useChat` via the component's DI seam instead of a global
// `mock.module('@ai-sdk/react')` — module mocks are process-global and leak into
// unrelated files under `--randomize` (see docs/development/testing.md).
const useChatStub = (() => ({ status: 'ready' })) as unknown as typeof useChat_default

const renderWithProviders = (props: ChatListItemProps) =>
  render(
    <SidebarProvider>
      <TooltipProvider>
        <ChatListItem {...props} useChat={useChatStub} />
      </TooltipProvider>
    </SidebarProvider>,
  )

const createProps = (overrides?: Partial<ChatListItemProps>): ChatListItemProps => ({
  thread: { id: 'thread-1', title: 'My Chat', isEncrypted: 0 },
  isActive: false,
  isCollapsed: false,
  isMobile: false,
  deleteChatMutation: { mutate: mock(), isPending: false } as never,
  threadIdRef: { current: null },
  deleteChatDialogRef: { current: { open: mock(), close: mock() } } as never,
  onChatClick: mock(),
  onRename: mock(),
  ...overrides,
})

describe('ChatListItem', () => {
  it('shows Rename and Delete options in the right-click context menu', async () => {
    renderWithProviders(createProps())
    fireEvent.contextMenu(screen.getByText('My Chat'))
    expect(await waitForElement(() => screen.queryByText('Rename'))).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('displays the chat title', () => {
    renderWithProviders(createProps())
    expect(screen.getByText('My Chat')).toBeInTheDocument()
  })

  it('navigates when clicking the chat item', () => {
    const onChatClick = mock()
    renderWithProviders(createProps({ onChatClick }))
    fireEvent.click(screen.getByText('My Chat'))
    expect(onChatClick).toHaveBeenCalledWith('thread-1')
  })

  it('renders icon-only view when collapsed', () => {
    renderWithProviders(createProps({ isCollapsed: true }))
    expect(screen.queryByText('My Chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Rename')).not.toBeInTheDocument()
  })
})
