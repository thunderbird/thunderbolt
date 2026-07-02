/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAutoScroll as useAutoScroll_default } from '@/hooks/use-auto-scroll'
import type { ThunderboltUIMessage } from '@/types'
import { useCallback, useEffect, useEffectEvent, useRef } from 'react'
import { useCurrentChatSession as useCurrentChatSession_default } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'
import { messageBookkeepingThrottleMs } from './chat-throttle'

// Viewport positioning constants
export const viewportPositioningMinMessages = 3 // Start viewport positioning after first exchange

// Helper to determine if viewport positioning should be used
export const shouldUseViewportPositioning = (messagesLength: number): boolean =>
  messagesLength >= viewportPositioningMinMessages

type MessagePart = ThunderboltUIMessage['parts'][number]

/**
 * Returns a value that changes whenever a single message part's rendered size grows:
 * text/reasoning length for text-bearing parts, the lifecycle state for tool parts.
 */
const partSizeToken = (part: MessagePart): string | number => {
  if ('text' in part) {
    return part.text.length
  }
  if ('state' in part) {
    return part.state
  }
  return ''
}

/**
 * Builds a cheap "content grew" fingerprint for the last (streaming) message: message
 * count, the last message id, its part count, and a per-part size token. It changes on
 * every visible growth (token text, a new part, or a tool part advancing state) without
 * depending on the messages array identity, which the AI SDK re-creates on every token
 * (via structuredClone) even when nothing visible changed. Scanning only the last
 * message's parts keeps this O(parts-of-last-message) per render.
 */
export const lastMessageContentSignal = (messages: ThunderboltUIMessage[]): string => {
  const lastMessage = messages[messages.length - 1]
  if (!lastMessage?.parts) {
    return `${messages.length}`
  }
  const partsFingerprint = lastMessage.parts.map(partSizeToken).join(':')
  return `${messages.length}:${lastMessage.id}:${lastMessage.parts.length}:${partsFingerprint}`
}

const userMessageViewportOffsetPx = 20 // Breathing room from top

type UseChatScrollHandlerProps = {
  useAutoScroll?: typeof useAutoScroll_default
  useChat?: typeof useChat_default
  useCurrentChatSession?: typeof useCurrentChatSession_default
}

export const useChatScrollHandler = ({
  useAutoScroll = useAutoScroll_default,
  useChat = useChat_default,
  useCurrentChatSession = useCurrentChatSession_default,
}: UseChatScrollHandlerProps = {}) => {
  const { chatInstance } = useCurrentChatSession()
  const { status, messages } = useChat({ chat: chatInstance, experimental_throttle: messageBookkeepingThrottleMs })
  const isStreaming = status === 'streaming'

  const prevStatusRef = useRef(status)
  const hasScrolledForFirstTokenRef = useRef(false)

  // Smallest correct "content grew" signal instead of the messages array identity, so the
  // auto-scroll effect re-runs on visible growth rather than on every SDK message clone.
  const contentSignal = lastMessageContentSignal(messages)

  const {
    scrollContainerRef,
    scrollTargetRef,
    scrollToBottom: rawScrollToBottom,
    scrollToElement: rawScrollToElement,
    resetUserScroll,
    scrollHandlers,
    isAtBottom,
  } = useAutoScroll({
    dependencies: [contentSignal],
    smooth: true,
    isStreaming,
    rootMargin: '0px 0px 20px 0px',
  })

  const onSubmitScroll = useEffectEvent(() => {
    hasScrolledForFirstTokenRef.current = false

    if (!shouldUseViewportPositioning(messages.length)) {
      rawScrollToBottom(true, true)
    } else {
      const userMessage = messages[messages.length - 1]

      if (userMessage?.role === 'user') {
        rawScrollToElement(`[data-message-id="${userMessage.id}"]`, userMessageViewportOffsetPx, true, true)
      } else {
        rawScrollToBottom(true, true)
      }
    }
  })

  const onFirstTokenScroll = useEffectEvent(() => {
    if (!shouldUseViewportPositioning(messages.length)) {
      rawScrollToBottom(true, true)
    }
  })

  // Scroll on status transition: submit
  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = status

    if (status === 'submitted' && prevStatus !== 'submitted') {
      onSubmitScroll()
    }
  }, [status, onSubmitScroll])

  // Derived once-per-stream flag: true only until the first assistant text token lands.
  // Reading the ref during render short-circuits the parts scan after it has fired, so the
  // scan runs only for the handful of renders before the first token (not every token).
  const lastMessage = messages[messages.length - 1]
  const assistantHasStreamedFirstToken =
    isStreaming &&
    !hasScrolledForFirstTokenRef.current &&
    lastMessage?.role === 'assistant' &&
    (lastMessage.parts?.some((part) => part.type === 'text' && part.text.length > 0) ?? false)

  // Scroll when first token arrives (only for first message exchange)
  useEffect(() => {
    if (!assistantHasStreamedFirstToken) {
      return
    }
    hasScrolledForFirstTokenRef.current = true
    onFirstTokenScroll()
  }, [assistantHasStreamedFirstToken])

  const scrollToBottomAndActivate = useCallback(
    (smooth?: boolean) => {
      const scrolled = rawScrollToBottom(smooth)
      if (scrolled) {
        resetUserScroll()
      }
    },
    [rawScrollToBottom, resetUserScroll],
  )

  return {
    isAtBottom,
    scrollContainerRef,
    scrollHandlers,
    scrollTargetRef,
    scrollToBottom: rawScrollToBottom,
    scrollToBottomAndActivate,
  }
}
