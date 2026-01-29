import { useAutoScroll as useAutoScroll_default } from '@/hooks/use-auto-scroll'
import { useCallback, useEffect, useRef } from 'react'
import { useCurrentChatSession } from './chat-store'
import { useChat as useChat_default } from '@ai-sdk/react'

type UseChatScrollHandlerProps = {
  useAutoScroll?: typeof useAutoScroll_default
  useChat?: typeof useChat_default
}

export const useChatScrollHandler = ({
  useAutoScroll = useAutoScroll_default,
  useChat = useChat_default,
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
    resetUserScroll,
    scrollHandlers,
    isAtBottom,
  } = useAutoScroll({
    dependencies: [messages],
    smooth: true,
    isStreaming,
    rootMargin: '0px 0px 20px 0px',
  })

  // Scroll on status transitions: submit + streaming start
  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = status

    const justSubmitted = status === 'submitted' && prevStatus !== 'submitted'
    const justStartedStreaming = status === 'streaming' && prevStatus === 'submitted'

    if (justSubmitted) {
      rawScrollToBottom(true, true) // smooth=true, programmatic=true
      hasScrolledForFirstTokenRef.current = false // Reset for new message
    } else if (justStartedStreaming) {
      rawScrollToBottom(true, true)
    }
  }, [status, rawScrollToBottom])

  // Scroll when first token arrives (actual AI response content)
  useEffect(() => {
    if (isStreaming && !hasScrolledForFirstTokenRef.current) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.role === 'assistant' && lastMessage.parts?.length > 0) {
        const hasContent = lastMessage.parts.some((part) => part.type === 'text' && part.text.length > 0)
        if (hasContent) {
          hasScrolledForFirstTokenRef.current = true
          rawScrollToBottom(true, true)
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
