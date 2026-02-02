import { useAutoScroll as useAutoScroll_default } from '@/hooks/use-auto-scroll'
import { useCallback, useEffect, useRef } from 'react'
import { useCurrentChatSession as useCurrentChatSession_default } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'

// Viewport positioning constants
export const viewportPositioningMinMessages = 3 // Start viewport positioning after first exchange

// Helper to determine if viewport positioning should be used
export const shouldUseViewportPositioning = (messagesLength: number): boolean =>
  messagesLength >= viewportPositioningMinMessages

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
  const { status, messages } = useChat({ chat: chatInstance })
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

  // Scroll on status transition: submit
  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = status

    const justSubmitted = status === 'submitted' && prevStatus !== 'submitted'

    if (justSubmitted) {
      hasScrolledForFirstTokenRef.current = false // Reset for new message

      // For first two messages, just scroll to bottom
      // From 3rd message onwards, immediately position viewport (grow up to make space for response)
      if (!shouldUseViewportPositioning(messages.length)) {
        rawScrollToBottom(true, true)
      } else {
        // Find user message (last message, which was just submitted)
        const userMessage = messages[messages.length - 1]

        if (userMessage?.role === 'user') {
          // Position user message at top with breathing room - viewport "grows up" to anticipate response
          rawScrollToElement(`[data-message-id="${userMessage.id}"]`, userMessageViewportOffsetPx, true, true)
        } else {
          // Fallback if last message isn't user message
          rawScrollToBottom(true, true)
        }
      }
    }
  }, [status, rawScrollToBottom, rawScrollToElement, messages])

  // Scroll when first token arrives (only for first message exchange)
  useEffect(() => {
    if (isStreaming && !hasScrolledForFirstTokenRef.current) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'assistant' && lastMessage.parts?.length > 0) {
        const hasContent = lastMessage.parts.some((part) => part.type === 'text' && part.text.length > 0)
        if (hasContent) {
          hasScrolledForFirstTokenRef.current = true

          // For first message exchange (2 messages: 1 user + 1 assistant), scroll to bottom
          // For 3rd+ messages, viewport was already positioned on submit, so do nothing
          if (!shouldUseViewportPositioning(messages.length)) {
            rawScrollToBottom(true, true)
          }
          // Otherwise: viewport already positioned on submit, no additional scroll needed
        }
      }
    }
  }, [isStreaming, messages, rawScrollToBottom])

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
