import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useContextTracking } from '@/hooks/use-context-tracking'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackEvent } from '@/lib/analytics'
import { getOrCreateChatThread } from '@/lib/dal'
import { cn } from '@/lib/utils'
import { Model, type Prompt, type ThunderboltUIMessage } from '@/types'
import type { UseChatHelpers } from '@ai-sdk/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { Button } from '../ui/button'
import { PromptInput } from '../ui/prompt-input'
import { AssistantMessage } from './assistant-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'

interface ChatUIProps {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  models: Model[]
  selectedModelId?: string
  onModelChange: (model: string | null) => void
  triggerPrompt?: Prompt
  chatThreadId?: string
}

interface SuggestionButtonProps {
  label: string
  prompt: string
  onSelect: (prompt: string) => void
}

const SuggestionButton = ({ label, prompt, onSelect }: SuggestionButtonProps) => (
  <Button
    variant="outline"
    className="bg-card text-sm text-foreground rounded-full px-3 py-1.5 border border-border shadow-sm hover:bg-accent whitespace-nowrap flex-shrink-0"
    onClick={() => onSelect(prompt)}
  >
    {label}
  </Button>
)

const SuggestionButtons = ({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) => {
  const suggestions = [
    { label: 'Check the weather', prompt: 'What is the forecast for this week?' },
    { label: 'Check your to dos', prompt: 'What are my current tasks?' },
    {
      label: 'Write a message',
      prompt: 'Write a thank you email to my coworker for helping with the meeting yesterday.',
    },
    {
      label: 'Understand a topic',
      prompt: 'Explain how checks and balances work between the three branches of government.',
    },
  ]

  return (
    <div className="flex flex-wrap gap-2 justify-center mt-4 w-full max-w-[696px] mx-auto">
      {suggestions.map((suggestion, index) => (
        <SuggestionButton key={index} label={suggestion.label} prompt={suggestion.prompt} onSelect={onSelectPrompt} />
      ))}
    </div>
  )
}

export default function ChatUI({
  chatHelpers,
  models,
  selectedModelId,
  onModelChange,
  triggerPrompt,
  chatThreadId,
}: ChatUIProps) {
  const [hasMessages, setHasMessages] = useState(chatHelpers.messages.length > 0)
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false)
  const [input, setInput] = useState('')
  const [showOverflowModal, setShowOverflowModal] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const previousMessageCountRef = useRef(chatHelpers.messages.length)
  const navigate = useNavigate()
  const isMobile = useIsMobile()

  const selectedModel = models.find((m) => m.id === selectedModelId) || models[0]

  const { usedTokens, maxTokens, isContextKnown, isOverflowing } = useContextTracking({
    model: selectedModel,
    chatThreadId,
    currentInput: input,
    onOverflow: () => setShowOverflowModal(true),
  })

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
    isStreaming: chatHelpers.status === 'streaming',
    rootMargin: '0px 0px -50px 0px', // 50px threshold from bottom
  })

  useEffect(() => {
    const currentMessageCount = chatHelpers.messages.length
    const previousMessageCount = previousMessageCountRef.current

    // Scroll to bottom when a new message is added
    if (currentMessageCount > previousMessageCount) {
      scrollToBottom()
      resetUserScroll() // Reset user scroll when new message starts
    } else if (chatHelpers.status === 'streaming' && !userHasScrolled) {
      // Continue scrolling during streaming as long as the user hasn't manually scrolled away
      scrollToBottom()
    }

    previousMessageCountRef.current = currentMessageCount
    setHasMessages(currentMessageCount > 0)
  }, [chatHelpers.messages, chatHelpers.status, scrollToBottom, resetUserScroll, userHasScrolled, isAtBottom])

  // Detect keyboard visibility on mobile
  useEffect(() => {
    if (!isMobile) return

    let timeout: NodeJS.Timeout
    const textareaElement = formRef.current?.querySelector('textarea')

    const handleFocus = (e: FocusEvent) => {
      if (e.target === textareaElement) {
        setIsKeyboardVisible(true)
        // Scroll the textarea into view after a small delay
        timeout = setTimeout(() => {
          textareaElement?.scrollIntoView({ behavior: 'smooth', block: 'end' })
        }, 300)
      }
    }

    const handleBlur = () => {
      clearTimeout(timeout)
      // Delay hiding to prevent flicker
      setTimeout(() => {
        setIsKeyboardVisible(false)
      }, 100)
    }

    document.addEventListener('focusin', handleFocus)
    document.addEventListener('focusout', handleBlur)

    return () => {
      clearTimeout(timeout)
      document.removeEventListener('focusin', handleFocus)
      document.removeEventListener('focusout', handleBlur)
    }
  }, [isMobile])

  const isStreaming = chatHelpers.status === 'streaming'

  const handleSubmit = async () => {
    // Prevent submitting while streaming or if input is empty
    const textToSend = input.trim()
    if (isStreaming || !textToSend) return

    if (isOverflowing) {
      setShowOverflowModal(true)
      trackEvent('chat_send_prompt_overflow', {
        model: selectedModelId,
        length: textToSend.length,
        prompt_number: chatHelpers.messages.length + 1,
      })
      return
    }

    trackEvent('chat_send_prompt', {
      model: selectedModelId,
      length: textToSend.length,
      prompt_number: chatHelpers.messages.length + 1,
    })

    // Clear the input immediately for responsive UX
    setInput('')

    await chatHelpers.sendMessage({ text: textToSend })

    // Reset user scroll state and scroll to bottom when submitting a new message
    resetUserScroll()
    setTimeout(() => scrollToBottom(), 100)
  }

  const handleSelectPrompt = (prompt: string) => {
    setInput(prompt)
    setTimeout(() => {
      const textareaElement = formRef.current?.querySelector('textarea')
      if (textareaElement) {
        textareaElement.focus()
      }
    }, 0)
  }

  const handleNewChat = async () => {
    const chatThreadId = await getOrCreateChatThread()
    await navigate(`/chats/${chatThreadId}`)
  }

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-background overflow-hidden w-full max-w-[728px] mx-auto min-w-[300px]',
        isMobile && isKeyboardVisible && 'pb-0',
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
            className="flex-1 p-4 overflow-y-auto space-y-4"
          >
            {/* Automation trigger banner */}
            {triggerPrompt && (
              <TriggerMessage title={triggerPrompt.title || 'Automation'} prompt={triggerPrompt.prompt} />
            )}

            {chatHelpers.messages.map((message, i) => {
              // Skip the very first user message if it was the automation prompt (already shown above)
              if (triggerPrompt && i === 0) {
                return null
              }

              if (message.role === 'assistant') {
                return (
                  <AssistantMessage
                    key={i}
                    message={message}
                    isStreaming={isStreaming && i === chatHelpers.messages.length - 1}
                  />
                )
              } else if (message.role === 'user') {
                return <UserMessage key={i} message={message} />
              }

              return null
            })}

            {/* Show error message if there's an error */}
            {chatHelpers.error && (
              <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto w-full">
                <p className="text-destructive font-medium mb-1">Error</p>
                <p className="text-destructive/80 text-sm">
                  {chatHelpers.error.message || 'An unexpected error occurred. Please try again.'}
                </p>
              </div>
            )}

            <div ref={scrollTargetRef} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        className={cn('p-4', isMobile && isKeyboardVisible && 'fixed bottom-0 left-0 right-0 bg-background z-50')}
        style={{
          display: 'flex',
          flex: !hasMessages && !(isMobile && isKeyboardVisible) ? '1' : 'none',
          alignItems: !hasMessages && !(isMobile && isKeyboardVisible) ? 'center' : 'flex-end',
          justifyContent: !hasMessages && !(isMobile && isKeyboardVisible) ? 'center' : 'flex-start',
        }}
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
              value={input}
              onChange={(value: string) => setInput(value)}
              placeholder="Say something..."
              models={models}
              selectedModelId={selectedModelId}
              onModelChange={onModelChange}
              showSubmitButton
              onSubmit={handleSubmit}
              isLoading={chatHelpers.status === 'streaming'}
              isStreaming={isStreaming}
              onStop={() => chatHelpers.stop()}
              autoFocus
              submitOnEnter={!isStreaming}
              className="flex flex-col gap-2 bg-secondary p-4 rounded-md w-full"
              footerStartElements={
                isContextKnown && <ContextUsageIndicator usedTokens={usedTokens ?? 0} maxTokens={maxTokens ?? 0} />
              }
            />
          </motion.div>

          {!hasMessages && !(isMobile && isKeyboardVisible) && (
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
  )
}
