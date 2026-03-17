import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { ChatListItem } from './chat-list-item'
import type { ChatListItemProps } from './types'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

// Mock useChat
mock.module('@ai-sdk/react', () => ({
  useChat: () => ({ status: 'ready' }),
}))

// Mock framer-motion
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => <div {...props}>{children as ReactNode}</div>,
  },
}))

// Mock Radix dropdown to render inline (avoids portal issues in tests)
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...props
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    className?: string
  }) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}))

const renderWithProviders = (props: ChatListItemProps) =>
  render(
    <SidebarProvider>
      <TooltipProvider>
        <ChatListItem {...props} />
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
  it('shows Rename and Delete options', () => {
    renderWithProviders(createProps())
    expect(screen.getByText('Rename')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
  })

  it('enters edit mode when Rename is clicked', () => {
    renderWithProviders(createProps())
    fireEvent.click(screen.getByText('Rename'))

    const input = screen.getByDisplayValue('My Chat')
    expect(input).toBeInTheDocument()
    expect(input.tagName).toBe('INPUT')
  })

  it('does not navigate when clicking the input', () => {
    const onChatClick = mock()
    renderWithProviders(createProps({ onChatClick }))
    fireEvent.click(screen.getByText('Rename'))

    const input = screen.getByDisplayValue('My Chat')
    fireEvent.click(input)

    expect(onChatClick).not.toHaveBeenCalled()
  })

  it('renders icon-only view when collapsed', () => {
    renderWithProviders(createProps({ isCollapsed: true }))
    expect(screen.queryByText('My Chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Rename')).not.toBeInTheDocument()
  })
})
