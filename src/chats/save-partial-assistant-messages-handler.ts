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

  // Intentionally UNthrottled: this is a durability subscriber, not a renderer.
  // It returns `children` unchanged (no subtree re-render) and its actual DB write
  // is already gated by its own `streamingSaveThrottleMs` `useThrottledCallback`, so per-token cost is
  // O(1) — throttling the `useChat` messages callback here would buy no perf while
  // widening the window where an aborted/errored stream's last partial goes unsaved
  // (`onFinish` doesn't persist on abort, and the effect's `isStreaming` guard skips
  // once status flips to `ready`).
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
      // Stream ended (or never started). On a success/abort terminal `onFinish`
      // performs the authoritative final save (see chat-instance.ts), so drop any
      // pending trailing partial to stop it firing *after* onFinish and clobbering
      // it with a stale, mid-stream snapshot. On an *error* terminal onFinish does
      // NOT persist, so this partial is the only record of what streamed before
      // the error — persist the *freshest* live message directly (the pending
      // trailing call holds an older delta's args and would drop the final chunk
      // when the last delta and the `error` flip coalesce into one commit), then
      // drop the now-redundant pending trailing.
      if (status === 'error' && isAssistantLatest) {
        saveStreamingMessage({ threadId: chatThreadId, message: latestMessage, parentId })
      }
      throttledSave.cancel()
      return
    }

    if (isAssistantLatest) {
      throttledSave(latestMessage, parentId)
    }
  }, [messages, isStreaming, status, throttledSave, saveStreamingMessage, chatThreadId])

  return children
}
