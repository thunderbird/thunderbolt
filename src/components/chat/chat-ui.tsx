import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useRef } from 'react'
import { SuggestionButtons } from './suggestion-buttons'
import { useChatScrollHandler } from '@/chats/use-chat-scroll-handler'
import { ChatMessages } from './chat-messages'
import { ChatPromptInput, type ChatPromptInputRef } from './chat-prompt-input'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChat } from '@ai-sdk/react'
import { useChatAutomation } from '@/chats/use-chat-automation'

export default function ChatUI() {
  const { chatInstance } = useCurrentChatSession()

  const { messages } = useChat({ chat: chatInstance })

  useChatAutomation()

  const hasMessages = messages.length

  const { resetUserScroll, scrollContainerRef, scrollHandlers, scrollTargetRef, scrollToBottom } =
    useChatScrollHandler()

  const chatPromptInputRef = useRef<ChatPromptInputRef>(null)
  const { isMobile, isReady } = useIsMobile()

  const handleSelectPrompt = useCallback((prompt: string) => {
    chatPromptInputRef.current?.setInput(prompt)
    chatPromptInputRef.current?.focus()
  }, [])

  if (!isReady) {
    return null
  }

  return (
    <div className="h-full w-full">
      <div
        className={cn(
          'flex flex-col h-full bg-background overflow-hidden w-full max-w-[728px] mx-auto min-w-[300px]',
          isMobile && 'pb-0',
        )}
      >
        <AnimatePresence>
          {hasMessages && (
            <motion.div
              ref={scrollContainerRef}
              {...scrollHandlers}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 p-4 space-y-4 max-w-dvw hide-scrollbar"
            >
              <ChatMessages />
              <div ref={scrollTargetRef} />
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          className={cn('p-4 flex', !hasMessages && 'flex-1 items-center')}
          initial={false}
          layout
          transition={{
            type: 'tween',
            ease: [0.2, 0.9, 0.1, 1],
            duration: 0.25,
          }}
        >
          <motion.div
            className="flex flex-col items-center w-full"
            layout
            transition={{
              type: 'tween',
              ease: [0.2, 0.9, 0.1, 1],
              duration: 0.25,
            }}
          >
            {!hasMessages && (
              <AnimatePresence>
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ delay: 0.1 }}
                  className="w-full max-w-[696px] overflow-x-auto pb-3"
                >
                  <SuggestionButtons onSelectPrompt={handleSelectPrompt} />
                </motion.div>
              </AnimatePresence>
            )}

            <motion.div
              className="w-full max-w-[696px] min-w-[268px]"
              layout
              transition={{
                type: 'tween',
                ease: [0.2, 0.9, 0.1, 1],
                duration: 0.25,
              }}
            >
              <ChatPromptInput
                handleResetUserScroll={resetUserScroll}
                handleScrollToBottom={scrollToBottom}
                ref={chatPromptInputRef}
              />
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}
