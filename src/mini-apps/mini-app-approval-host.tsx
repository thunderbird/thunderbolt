/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { MiniAppApprovalPrompt } from './mini-app-approval-prompt'

/** Renders the current chat's queued page or local-tool approval above its prompt. */
export const MiniAppApprovalHost = () => {
  const { miniAppApprovalQueue } = useCurrentChatSession()
  // The head of this chat's queue is the one on screen; the rest wait their turn.
  const pendingApproval = miniAppApprovalQueue[0] ?? null

  if (!pendingApproval) {
    return null
  }

  return (
    <MiniAppApprovalPrompt
      pending={pendingApproval}
      appName={pendingApproval.appName}
      /* Bound to the entry that was rendered, so a double-click or a click
       * racing the deadline cannot answer the request that just took its
       * place. `decide` is idempotent, so the second one is dropped. */
      onDecide={pendingApproval.decide}
    />
  )
}
