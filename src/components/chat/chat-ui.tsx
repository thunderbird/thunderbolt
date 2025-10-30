import { useContextTracking } from '@/hooks/use-context-tracking'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackEvent } from '@/lib/posthog'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { PromptInput } from '../ui/prompt-input'
import { SuggestionButtons } from './suggestion-buttons'
import { useChatScrollHandler } from '@/chats/use-chat-scroll-handler'
import { useChatState } from '@/chats/chat-state-provider'
import { useChatData } from '@/chats/chat-data-provider'
import { ChatMessages } from './chat-messages'

export default function ChatUI() {
  const { chatThread, id: chatThreadId, models } = useChatData()

  const { handleModelChange, handleSendMessage, handleStop, hasMessages, isStreaming, messages, selectedModel } =
    useChatState()

  const { resetUserScroll, scrollContainerRef, scrollHandlers, scrollTargetRef, scrollToBottom } = useChatScrollHandler(
    {
      hasMessages,
      isStreaming,
      messages,
    },
  )

  const [input, setInput] = useState('')
  const [showOverflowModal, setShowOverflowModal] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const navigate = useNavigate()
  const { isMobile, isReady } = useIsMobile()

  const { usedTokens, maxTokens, isContextKnown, isOverflowing } = useContextTracking({
    model: selectedModel,
    chatThreadId,
    currentInput: input,
    onOverflow: () => setShowOverflowModal(true),
  })

  const handleSubmit = async () => {
    // Prevent submitting while streaming or if input is empty
    const textToSend = input.trim()
    if (isStreaming || !textToSend) return

    if (isOverflowing) {
      setShowOverflowModal(true)
      trackEvent('chat_send_prompt_overflow', {
        model: selectedModel,
        length: textToSend.length,
        prompt_number: messages.length + 1,
      })
      return
    }

    // Clear the input immediately for responsive UX
    setInput('')

    await handleSendMessage(textToSend)

    // Reset user scroll state and scroll to bottom when submitting a new message
    resetUserScroll()
    requestAnimationFrame(() => {
      scrollToBottom()
    })
  }

  const handleSelectPrompt = useCallback((prompt: string) => {
    setInput(prompt)
    requestAnimationFrame(() => {
      const textareaElement = formRef.current?.querySelector('textarea')
      if (textareaElement) {
        textareaElement.focus()
      }
    })
  }, [])

  const handleNewChat = async () => {
    await navigate('/chats/new')
  }

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
              className="flex-1 p-4 overflow-y-auto space-y-4 max-w-dvw"
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
            <motion.div
              className="w-full max-w-[696px] min-w-[268px]"
              layout
              transition={{
                type: 'tween',
                ease: [0.2, 0.9, 0.1, 1],
                duration: 0.25,
              }}
            >
              <PromptInput
                ref={formRef}
                chatThread={chatThread}
                value={input}
                onChange={(value: string) => setInput(value)}
                placeholder="Say something..."
                models={models}
                selectedModelId={selectedModel.id}
                onModelChange={handleModelChange}
                showSubmitButton
                onSubmit={handleSubmit}
                isLoading={isStreaming}
                isStreaming={isStreaming}
                onStop={handleStop}
                autoFocus
                submitOnEnter={!isStreaming}
                className="flex flex-col gap-2 bg-secondary p-4 rounded-md w-full"
                footerStartElements={
                  isContextKnown && <ContextUsageIndicator usedTokens={usedTokens ?? 0} maxTokens={maxTokens ?? 0} />
                }
              />
            </motion.div>

            {!hasMessages && (
              <AnimatePresence>
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ delay: 0.1 }}
                  className="w-full overflow-x-auto pb-2"
                >
                  <SuggestionButtons onSelectPrompt={handleSelectPrompt} />
                </motion.div>
              </AnimatePresence>
            )}
          </motion.div>
        </motion.div>

        <ContextOverflowModal
          isOpen={showOverflowModal}
          onClose={() => setShowOverflowModal(false)}
          maxTokens={maxTokens ?? undefined}
          onNewChat={handleNewChat}
        />
      </div>
    </div>
  )
}
