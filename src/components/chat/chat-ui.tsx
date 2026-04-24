import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { useChatScrollHandler } from '@/chats/use-chat-scroll-handler'
import { ChatMessages } from './chat-messages'
import { ChatPromptInput, type ChatPromptInputRef } from './chat-prompt-input'
import { NoAgentsMessage } from './no-agents-message'
import { useCurrentChatSession } from '@/chats/chat-store'
import { useChatStore } from '@/chats/chat-store'
import { useChatAutomation } from '@/chats/use-chat-automation'
import { ScrollToBottomButton } from './scroll-to-bottom-button'
import { AppLogo } from '../app-logo'
import type { SaveMessagesFunction } from '@/types'

type ChatUIProps = {
  saveMessages?: SaveMessagesFunction
}

const ChatUI = ({ saveMessages }: ChatUIProps) => {
  const { messages, agentConfig } = useCurrentChatSession()
  const agents = useChatStore((s) => s.agents)
  const isBuiltInAgent = agentConfig.type === 'built-in'
  const hasNoAgents = agents.length === 0

  useChatAutomation()

  const hasMessages = messages.length

  const { isAtBottom, scrollContainerRef, scrollHandlers, scrollTargetRef, scrollToBottom, scrollToBottomAndActivate } =
    useChatScrollHandler()

  const { isMobile } = useIsMobile()

  // Scroll to bottom instantly when entering an existing chat
  // Effect re-runs when scrollToBottom changes (when container becomes available)
  const hasScrolledInitially = useRef(false)
  useEffect(() => {
    if (hasMessages && !hasScrolledInitially.current) {
      // scrollToBottom returns true if scroll was performed, false if container not ready
      // Only mark as scrolled when it actually succeeds
      const scrolled = scrollToBottom(false)
      if (scrolled) {
        hasScrolledInitially.current = true
      }
    }
  }, [hasMessages, scrollToBottom])

  if (hasNoAgents) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <NoAgentsMessage />
      </div>
    )
  }

  return (
    <div className="h-full w-full">
      <div
        className={cn(
          'flex flex-col h-full overflow-hidden w-full max-w-[728px] mx-auto min-w-[300px]',
          isMobile && 'pb-0',
        )}
      >
        <AnimatePresence mode="wait">
          {hasMessages ? (
            <div key="messages" className="relative flex-1 min-h-0">
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-background via-background/50 to-transparent" />
              <motion.div
                ref={scrollContainerRef}
                {...scrollHandlers}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full px-3 pt-4 pb-0 md:px-4 space-y-4 max-w-dvw overflow-y-auto hide-scrollbar"
              >
                <ChatMessages />
                <div ref={scrollTargetRef} className="shrink-0 !mt-0 h-2 md:h-3" />
              </motion.div>
              <ScrollToBottomButton
                isVisible={!isAtBottom}
                onClick={() => scrollToBottomAndActivate(true)}
                className="bottom-6 md:bottom-7"
              />
            </div>
          ) : isMobile ? (
            <motion.div
              key="logo"
              className="flex-1 flex items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <AppLogo size={64} className="opacity-60" />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <motion.div
          className={cn(
            '-mt-3 md:-mt-4 relative z-10 px-3 pb-3 md:px-4 md:pb-4 flex',
            !hasMessages && !isMobile && 'flex-1 items-center',
          )}
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
            {!hasMessages && isBuiltInAgent && (
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
              className="w-full max-w-[696px] min-w-[268px] bg-card dark:bg-[oklch(0.182_0_0)] border dark:border-input rounded-2xl"
              layout
              transition={{
                type: 'tween',
                ease: [0.2, 0.9, 0.1, 1],
                duration: 0.25,
              }}
            >
              <ChatPromptInput ref={chatPromptInputRef} saveMessages={saveMessages} />
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}

export default ChatUI
