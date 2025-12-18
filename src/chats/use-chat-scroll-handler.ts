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

  const { scrollContainerRef, scrollTargetRef, scrollToBottom, resetUserScroll, scrollHandlers, userHasScrolled } =
    useAutoScroll({
      dependencies: [messages],
      smooth: true,
      isStreaming,
    })

  const handleScrollToBottom = useCallback(
    (smooth?: boolean) => {
      scrollToBottom(smooth)
      resetUserScroll()
    },
    [scrollToBottom, resetUserScroll],
  )

  return {
    isAtBottom: !userHasScrolled,
    resetUserScroll,
    scrollContainerRef,
    scrollHandlers,
    scrollTargetRef,
    scrollToBottom: handleScrollToBottom,
  }
}
