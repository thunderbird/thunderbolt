import { useAutoScroll as useAutoScroll_default } from '@/hooks/use-auto-scroll'
import { useEffect, useRef } from 'react'
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

  const hasMessages = messages.length

  const isStreaming = status === 'streaming'

  const {
    scrollContainerRef,
    scrollTargetRef,
    scrollToBottom,
    resetUserScroll,
    scrollHandlers,
    userHasScrolled,
    isAtBottom,
  } = useAutoScroll({
    dependencies: [],
    smooth: true,
    isStreaming,
    rootMargin: '0px 0px -50px 0px', // 50px threshold from bottom
  })

  const previousMessageCountRef = useRef(messages.length)

  useEffect(() => {
    const currentMessageCount = messages.length
    const previousMessageCount = previousMessageCountRef.current

    // Scroll to bottom when a new message is added
    if (currentMessageCount > previousMessageCount) {
      requestAnimationFrame(() => {
        scrollToBottom()
        resetUserScroll() // Reset user scroll when new message starts
      })
    } else if (isStreaming && !userHasScrolled) {
      // Continue scrolling during streaming as long as the user hasn't manually scrolled away
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    }

    previousMessageCountRef.current = currentMessageCount
  }, [scrollToBottom, resetUserScroll, userHasScrolled, isAtBottom, messages, isStreaming])

  useEffect(() => {
    if (!hasMessages) return

    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        scrollToBottom(false)
      })
    })

    return () => cancelAnimationFrame(frame)
  }, [hasMessages, scrollToBottom])

  return {
    resetUserScroll,
    scrollContainerRef,
    scrollHandlers,
    scrollTargetRef,
    scrollToBottom,
  }
}
