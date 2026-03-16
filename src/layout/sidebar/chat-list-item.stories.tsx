import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ChatListItem } from './chat-list-item'
import type { ChatThread } from './types'

const meta = {
  title: 'layout/sidebar/ChatListItem',
  component: ChatListItem,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Individual chat thread item that can be collapsed or expanded with a dropdown menu.',
      },
    },
  },
  decorators: [
    (Story) => (
      <SidebarProvider>
        <TooltipProvider>
          <div className="w-64 border rounded-lg p-2 bg-sidebar">
            <Story />
          </div>
        </TooltipProvider>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof ChatListItem>

export default meta
type Story = StoryObj<typeof meta>

const mockThread: ChatThread = {
  id: '1',
  title: 'Example Chat Thread',
  isEncrypted: 0,
}

const encryptedThread: ChatThread = {
  id: '2',
  title: 'Encrypted Chat Thread',
  isEncrypted: 1,
}

export const Expanded: Story = {
  args: {
    thread: mockThread,
    isActive: false,
    isCollapsed: false,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: false,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'Expanded view showing full title and dropdown menu.',
      },
    },
  },
}

export const ExpandedActive: Story = {
  args: {
    thread: mockThread,
    isActive: true,
    isCollapsed: false,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: false,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'Expanded view when the chat thread is currently active.',
      },
    },
  },
}

export const ExpandedEncrypted: Story = {
  args: {
    thread: encryptedThread,
    isActive: false,
    isCollapsed: false,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: false,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'Expanded view of an encrypted chat thread (shows lock icon).',
      },
    },
  },
}

export const Collapsed: Story = {
  args: {
    thread: mockThread,
    isActive: false,
    isCollapsed: true,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: false,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'Collapsed icon-only view showing message icon with tooltip.',
      },
    },
  },
}

export const CollapsedActive: Story = {
  args: {
    thread: mockThread,
    isActive: true,
    isCollapsed: true,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: false,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'Collapsed view when the chat thread is currently active.',
      },
    },
  },
}

export const CollapsedEncrypted: Story = {
  args: {
    thread: encryptedThread,
    isActive: false,
    isCollapsed: true,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: false,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'Collapsed view of encrypted thread (lock icon shown in tooltip).',
      },
    },
  },
}

export const Deleting: Story = {
  args: {
    thread: mockThread,
    isActive: false,
    isCollapsed: false,
    isMobile: false,
    deleteChatMutation: {
      mutate: () => console.log('Delete clicked'),
      isPending: true,
    } as any,
    threadIdRef: { current: null },
    deleteChatDialogRef: {
      current: { open: () => console.log('Open delete dialog'), close: () => console.log('Close delete dialog') },
    } as any,
    onChatClick: () => console.log('Chat clicked'),
    onRename: (threadId: string, title: string) => console.log('Rename', threadId, title),
  },
  parameters: {
    docs: {
      description: {
        story: 'State when delete operation is in progress (shows spinner in dropdown).',
      },
    },
  },
}
