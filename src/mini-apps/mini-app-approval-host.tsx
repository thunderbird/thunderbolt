/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession } from '@/chats/chat-store'
import { useMiniAppStore } from './mini-app-store'
import { MiniAppApprovalPrompt } from './mini-app-approval-prompt'

/**
 * Renders the pending Mini App tool approval above the prompt input.
 *
 * The sibling of {@link PermissionDialogHost}, mounted in the same slot in
 * `ChatUI` and for the same reason: a decision the turn is blocked on belongs
 * where the user is already reading. In an ordinary chat there is no active app
 * and so nothing to render, which is why this can sit unconditionally in the
 * shared chat surface rather than only in the Mini App panel.
 *
 * It reads the queue off the *current session*, like `PermissionDialogHost`
 * does — a global queue meant switching chats could show a prompt belonging to
 * a conversation the user had left.
 *
 * The deadline lives with the request, not here — see `requestMiniAppApproval`.
 * A prompt that unmounts (the user navigates away mid-decision) must still
 * resolve the `execute` it is blocking, so the timer cannot belong to a
 * component.
 */
export const MiniAppApprovalHost = () => {
  const activeApp = useMiniAppStore((state) => state.activeApp)
  const { miniAppApprovalQueue } = useCurrentChatSession()
  // The head of this chat's queue is the one on screen; the rest wait their turn.
  const pendingApproval = miniAppApprovalQueue[0] ?? null

  if (!pendingApproval || !activeApp) {
    return null
  }

  return (
    <MiniAppApprovalPrompt
      pending={pendingApproval}
      appName={activeApp.name}
      /* Bound to the entry that was rendered, so a double-click or a click
       * racing the deadline cannot answer the request that just took its
       * place. `decide` is idempotent, so the second one is dropped. */
      onDecide={pendingApproval.decide}
    />
  )
}
