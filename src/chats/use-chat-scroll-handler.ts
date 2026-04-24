import { useAutoScroll as useAutoScroll_default } from '@/hooks/use-auto-scroll'
import { useCallback, useEffect, useEffectEvent, useRef } from 'react'
import { useCurrentChatSession as useCurrentChatSession_default } from './chat-store'

// Viewport positioning constants
export const viewportPositioningMinMessages = 3 // Start viewport positioning after first exchange

// Helper to determine if viewport positioning should be used
export const shouldUseViewportPositioning = (messagesLength: number): boolean =>
  messagesLength >= viewportPositioningMinMessages

const userMessageViewportOffsetPx = 20 // Breathing room from top

type UseChatScrollHandlerProps = {
  useAutoScroll?: typeof useAutoScroll_default
  useCurrentChatSession?: typeof useCurrentChatSession_default
}

export const useChatScrollHandler = ({
  useAutoScroll = useAutoScroll_default,
  useCurrentChatSession = useCurrentChatSession_default,
}: UseChatScrollHandlerProps = {}) => {
  const { messages, status } = useCurrentChatSession()
  const isStreaming = status === 'streaming'

  const prevStatusRef = useRef(status)
  const hasScrolledForFirstTokenRef = useRef(false)

  const {
    scrollContainerRef,
    scrollTargetRef,
    scrollToBottom: rawScrollToBottom,
    scrollToElement: rawScrollToElement,
    resetUserScroll,
    scrollHandlers,
    isAtBottom,
  } = useAutoScroll({
    dependencies: [messages],
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

  // Scroll when first token arrives (only for first message exchange)
  useEffect(() => {
    if (isStreaming && !hasScrolledForFirstTokenRef.current) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'assistant' && lastMessage.parts?.length > 0) {
        const hasContent = lastMessage.parts.some((part) => part.type === 'text' && part.text.length > 0)
        if (hasContent) {
          hasScrolledForFirstTokenRef.current = true
          onFirstTokenScroll()
        }
      }
    }
  }, [isStreaming, messages, onFirstTokenScroll])

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
