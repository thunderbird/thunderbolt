import { useAutoScroll as useAutoScroll_default } from '@/hooks/use-auto-scroll'
import { useCallback } from 'react'
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
