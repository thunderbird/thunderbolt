/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useThrottledCallback } from '@/hooks/use-throttle'
import type { SaveStreamingMessageFunction, ThunderboltUIMessage } from '@/types'
import { type PropsWithChildren, useEffect } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'

/**
 * How often, at most, an in-flight assistant message is persisted while it
 * streams. Partial saves exist only for crash recovery, so a coarser cadence
 * than the per-token render rate is fine — the authoritative complete save runs
 * in the chat instance's `onFinish`. Larger = fewer heavy writes (full-message
 * JSON serialize + E2EE re-encryption of the growing message) during the stream.
 */
const streamingSaveThrottleMs = 500

type SavePartialAssistantMessagesHandlerProps = PropsWithChildren<{
  saveStreamingMessage: SaveStreamingMessageFunction
  useChat?: typeof useChat_default
}>

/**
 * Hook that saves partial assistant messages to the database while the chat is
 * streaming, for crash recovery. Uses the lightweight
 * {@link SaveStreamingMessageFunction} fast path (no thread create / title /
 * navigation, no redundant per-save SELECTs). Dependency-injected to avoid
 * mocking modules in tests.
 */
export const SavePartialAssistantMessagesHandler = ({
  children,
  saveStreamingMessage,
  useChat = useChat_default,
}: SavePartialAssistantMessagesHandlerProps) => {
  const { chatInstance, id: chatThreadId } = useCurrentChatSession()

  // Subscribe without throttling so the trailing save is cancelled as soon as
  // streaming ends. Database writes already have their own throttle below.
  const { status, messages } = useChat({ chat: chatInstance })

  const isStreaming = status === 'streaming'

  const throttledSave = useThrottledCallback((message: ThunderboltUIMessage, parentId: string | null) => {
    saveStreamingMessage({ threadId: chatThreadId, message, parentId })
  }, streamingSaveThrottleMs)

  useEffect(() => {
    // The parent is the message immediately before the in-flight assistant turn
    // (its user prompt). Reading it from the in-memory list avoids a per-save
    // `getLastMessage` query and can never self-reference the row being written.
    const latestMessage = messages[messages.length - 1]
    const parentId = messages[messages.length - 2]?.id ?? null
    const isAssistantLatest = latestMessage?.role === 'assistant'

    if (!isStreaming) {
      // onFinish owns the authoritative final save, including errors and aborts.
      // A trailing partial must never overwrite it with an older snapshot.
      throttledSave.cancel()
      return
    }

    // A turn that has opened but produced no part yet has nothing to recover, and
    // persisting the empty shell outlives the in-memory drop an aborted turn does
    // (chat-instance.ts) — on reload it resurfaces as a failed turn the user had
    // deliberately stopped.
    if (isAssistantLatest && latestMessage.parts.some((part) => part.type !== 'step-start')) {
      throttledSave(latestMessage, parentId)
    }
  }, [messages, isStreaming, throttledSave])

  return children
}
