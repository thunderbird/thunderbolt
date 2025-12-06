import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import type { UseMutationResult } from '@tanstack/react-query'
import type { RefObject } from 'react'

export type ChatThread = {
  id: string
  title: string | null
  isEncrypted: number
}

export type DeleteChatMutationType = UseMutationResult<void, Error, { id: string }, unknown>

export type DeleteAllChatsMutationType = UseMutationResult<void, Error, void, unknown>

export type ChatActionsProps = {
  isCollapsed: boolean
  debouncedSearchQuery: string
  deleteAllChatsMutation: DeleteAllChatsMutationType
  deleteAllChatsDialogRef: RefObject<DeleteAllChatsDialogRef | null>
  onSearchClick: (e?: React.MouseEvent) => void
}

export type ChatListProps = {
  chatThreads: ChatThread[]
  currentChatThreadId?: string
  isCollapsed: boolean
  isMobile: boolean
  debouncedSearchQuery: string
  deleteAllChatsMutation: DeleteAllChatsMutationType
  deleteChatMutation: DeleteChatMutationType
  deleteAllChatsDialogRef: RefObject<DeleteAllChatsDialogRef | null>
  deleteChatDialogRef: RefObject<DeleteChatDialogRef | null>
  threadIdRef: RefObject<string | null>
  searchQuery: string
  showSearch: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  onChatClick: (threadId: string) => void
  onSearchClick: (e?: React.MouseEvent) => void
  onSearchQueryChange: (value: string) => void
}

export type ChatListItemProps = {
  thread: ChatThread
  isActive: boolean
  isCollapsed: boolean
  isMobile: boolean
  deleteChatMutation: DeleteChatMutationType
  threadIdRef: RefObject<string | null>
  deleteChatDialogRef: RefObject<DeleteChatDialogRef | null>
  onChatClick: (threadId: string) => void
}
