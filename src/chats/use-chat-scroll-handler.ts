import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useEffect, useRef } from 'react'
import { useChatState } from './chat-state-provider'

export const useChatScrollHandler = () => {
  const { hasMessages, isStreaming, messages } = useChatState()

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
        scrollToBottom()
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
