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

const clickRename = () => {
  fireEvent.click(screen.getByText('Rename'))
}

describe('ChatListItem', () => {
  describe('rename', () => {
    it('shows Rename and Delete options', () => {
      renderWithProviders(createProps())
      expect(screen.getByText('Rename')).toBeInTheDocument()
      expect(screen.getByText('Delete')).toBeInTheDocument()
    })

    it('enters edit mode when Rename is clicked', () => {
      renderWithProviders(createProps())
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      expect(input).toBeInTheDocument()
      expect(input.tagName).toBe('INPUT')
    })

    it('calls onRename with new title on Enter', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.change(input, { target: { value: 'Renamed Chat' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('thread-1', 'Renamed Chat')
    })

    it('calls onRename on blur', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.change(input, { target: { value: 'Blurred Title' } })
      fireEvent.blur(input)

      expect(onRename).toHaveBeenCalledWith('thread-1', 'Blurred Title')
    })

    it('cancels editing on Escape without calling onRename', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.change(input, { target: { value: 'Changed' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(onRename).not.toHaveBeenCalled()
      expect(screen.getByText('My Chat')).toBeInTheDocument()
    })

    it('does not call onRename on blur after Escape', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.change(input, { target: { value: 'Changed' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)

      expect(onRename).not.toHaveBeenCalled()
    })

    it('succeeds on the first rename attempt after a cancel', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))

      // First: cancel a rename
      clickRename()
      const input = screen.getByDisplayValue('My Chat')
      fireEvent.keyDown(input, { key: 'Escape' })

      // Second: rename should work on the next attempt
      clickRename()
      const input2 = screen.getByDisplayValue('My Chat')
      fireEvent.change(input2, { target: { value: 'After Cancel' } })
      fireEvent.keyDown(input2, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('thread-1', 'After Cancel')
    })

    it('does not call onRename when title is unchanged', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).not.toHaveBeenCalled()
    })

    it('falls back to "New Chat" when input is cleared and submitted', () => {
      const onRename = mock()
      renderWithProviders(createProps({ onRename }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('thread-1', 'New Chat')
    })

    it('uses "New Chat" as initial edit value when thread title is null', () => {
      renderWithProviders(
        createProps({
          thread: { id: 'thread-1', title: null, isEncrypted: 0 },
        }),
      )
      clickRename()

      expect(screen.getByDisplayValue('New Chat')).toBeInTheDocument()
    })

    it('does not navigate when clicking the input', () => {
      const onChatClick = mock()
      renderWithProviders(createProps({ onChatClick }))
      clickRename()

      const input = screen.getByDisplayValue('My Chat')
      fireEvent.click(input)

      expect(onChatClick).not.toHaveBeenCalled()
    })
  })

  describe('collapsed', () => {
    it('renders icon-only view when collapsed', () => {
      renderWithProviders(createProps({ isCollapsed: true }))
      expect(screen.queryByText('My Chat')).not.toBeInTheDocument()
      expect(screen.queryByText('Rename')).not.toBeInTheDocument()
    })
  })
})
