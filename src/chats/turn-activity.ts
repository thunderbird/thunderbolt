/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { ChatStatus } from 'ai'

export type TurnActivityInput = {
  status: ChatStatus
  lastMessage: ThunderboltUIMessage | undefined
  /** Whether `useChat` surfaced a chat-level error for the current turn. */
  hasChatError: boolean
  retriesExhausted: boolean
  retryCount: number
}

export type TurnActivity = {
  isStreaming: boolean
  /** A live request: the model is thinking (`submitted`) or emitting (`streaming`). */
  isGenerating: boolean
  /** `submitted` with no assistant message yet to host the loading indicator. */
  showSubmittedLoading: boolean
  emptyAssistantTurn: boolean
  /** The model returned an empty turn and the app is (or should be) recovering
   *  it — the thread shows a spinner, `status` is back to `ready`. */
  pendingEmptyTurnRecovery: boolean
  hasError: boolean
  /**
   * The turn is doing something the user can Stop: a live request, an empty-turn
   * recovery spinner, or an auto-retry backoff. This is the single signal both the
   * composer's Stop button and the thread's loading indicator key off, so the two
   * can't disagree (THU-791 was exactly that disagreement).
   */
  isActive: boolean
}

/**
 * Derive a turn's activity from `useChat`'s reactive state. Pure so both
 * `ChatMessages` (spinner) and `ChatPromptInput` (Stop button) compute it from
 * the same inputs and stay in lockstep.
 */
export const getTurnActivity = ({
  status,
  lastMessage,
  hasChatError,
  retriesExhausted,
  retryCount,
}: TurnActivityInput): TurnActivity => {
  const isStreaming = status === 'streaming'
  const isGenerating = status === 'submitted' || isStreaming
  const showSubmittedLoading = status === 'submitted' && lastMessage?.role !== 'assistant'
  const emptyAssistantTurn = lastMessage?.role === 'assistant' && !lastMessage.parts?.length && !isStreaming
  const pendingEmptyTurnRecovery = emptyAssistantTurn && !hasChatError && !retriesExhausted
  const hasError = hasChatError || (emptyAssistantTurn && retriesExhausted)
  const isActive = isGenerating || pendingEmptyTurnRecovery || (retryCount > 0 && !retriesExhausted)
  return {
    isStreaming,
    isGenerating,
    showSubmittedLoading,
    emptyAssistantTurn,
    pendingEmptyTurnRecovery,
    hasError,
    isActive,
  }
}
