/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DeleteAllChatsDialogRef } from '@/components/delete-all-chats-dialog'
import type { DeleteChatDialogRef } from '@/components/delete-chat-dialog'
import type { UseMutationResult } from '@tanstack/react-query'
import type { ReactNode, RefObject } from 'react'

/** Top-level sidebar sections switchable via the nav toggle. */
export type SidebarSection = 'chats' | 'settings'

export type ChatThread = {
  id: string
  title: string | null
  isEncrypted: number
}

export type DeleteChatMutationType = UseMutationResult<void, Error, { id: string }, unknown>

export type DeleteAllChatsMutationType = UseMutationResult<void, Error, void, unknown>

export type ChatActionsProps = {
  isCollapsed: boolean
  /** Whether to render the "Clear all chats" action — hidden when there are no chats. */
  showClearAll: boolean
  deleteAllChatsMutation: DeleteAllChatsMutationType
  deleteAllChatsDialogRef: RefObject<DeleteAllChatsDialogRef | null>
  onSearchClick: () => void
}

export type ChatListProps = {
  chatThreads: ChatThread[]
  currentChatThreadId?: string
  isCollapsed: boolean
  isMobile: boolean
  deleteAllChatsMutation: DeleteAllChatsMutationType
  deleteChatMutation: DeleteChatMutationType
  deleteAllChatsDialogRef: RefObject<DeleteAllChatsDialogRef | null>
  deleteChatDialogRef: RefObject<DeleteChatDialogRef | null>
  threadIdRef: RefObject<string | null>
  mobileNavToggle: ReactNode
  mobileSecondaryNavigation: ReactNode
  onChatClick: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onSearchClick: () => void
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
  onRename: (threadId: string, title: string) => void
}
