/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Asking the user to approve a Mini App write tool.
 *
 * The state lives on the chat session (`chat-store.ts`), because the decision
 * belongs to the conversation that provoked it. What lives here is the part
 * that isn't state: the deadline, and the guarantee that one request is
 * answered exactly once.
 *
 * Neither can belong to the prompt component. A prompt that unmounts — the user
 * navigates away mid-decision — must still resolve the `execute` it is
 * blocking, or the turn spins forever.
 */

import { useChatStore, type PendingMiniAppApproval } from '@/chats/chat-store'
import type { MiniAppTool } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

/**
 * How long an unanswered approval prompt waits before denying itself.
 *
 * Two minutes: long enough to read the prompt, look at the app and think, short
 * enough that a turn nobody is coming back to eventually ends instead of
 * spinning forever.
 */
export const approvalTimeoutMs = 120_000

export type RequestMiniAppApprovalOptions = {
  /** The chat that provoked the call — also its `chat-store` session key. */
  chatThreadId: string
  app: MiniAppDefinition
  tool: MiniAppTool
  args: unknown
}

/**
 * Block until the user approves this call, denying on a deadline.
 *
 * Resolves false rather than hanging when there is nothing to ask: no live
 * session for the originating chat, or the deadline passing.
 *
 * Denying on a deadline matters because this promise is holding the model's
 * streaming request open, so a prompt the user walks away from doesn't just sit
 * there — it wedges the turn, with a spinner and no explanation. Denying is the
 * safe default and the model is told why, so it can say something useful
 * instead of stalling. The window is deliberately long: a decision about
 * someone's data is worth reading properly, and being slightly too patient
 * costs far less than approving something by timeout.
 *
 * The clock starts when the call is made, not when its prompt reaches the
 * screen. A queued call is holding its turn open just as much as the one on
 * screen is.
 */
export const requestMiniAppApproval = ({
  chatThreadId,
  app,
  tool,
  args,
}: RequestMiniAppApprovalOptions): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    /*
     * Answered exactly once.
     *
     * The store used to resolve "the head of the queue", so a double-click — or
     * a click landing just as the deadline fired — answered the request that
     * had just moved into view, which the user had not read. Identity plus this
     * latch is what makes that impossible: a second answer to a settled request
     * is dropped, and the entry it removes is the one it was created for.
     */
    let settled = false

    const settle = (approved: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      useChatStore.getState().dequeueMiniAppApproval(chatThreadId, pending)
      resolve(approved)
    }

    const timer = setTimeout(() => settle(false), approvalTimeoutMs)

    const pending: PendingMiniAppApproval = { appId: app.id, tool, args, decide: settle }

    if (!useChatStore.getState().enqueueMiniAppApproval(chatThreadId, pending)) {
      settle(false)
    }
  })
