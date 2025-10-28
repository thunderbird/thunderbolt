import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useContextTracking } from '@/hooks/use-context-tracking'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackEvent } from '@/lib/posthog'
import { cn } from '@/lib/utils'
import type { AutomationRun, Model, ThunderboltUIMessage } from '@/types'
import type { UseChatHelpers } from '@ai-sdk/react'
import { AnimatePresence, motion } from 'framer-motion'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { Button } from '../ui/button'
import { PromptInput } from '../ui/prompt-input'
import { AssistantMessage } from './assistant-message'
import { TriggerMessage } from './trigger-message'
import { UserMessage } from './user-message'
import { useQuery } from '@tanstack/react-query'
import { getChatThread } from '@/dal'
import { EncryptionMessage } from './encryption-message'

interface ChatUIProps {
  chatHelpers: UseChatHelpers<ThunderboltUIMessage>
  models: Model[]
  selectedModelId?: string
  onModelChange: (model: string | null) => void
  triggerAutomation?: AutomationRun | null
  chatThreadId: string
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

const SuggestionButtons = memo(({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) => {
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
})

export default function ChatUI({
  chatHelpers,
  models,
  selectedModelId,
  onModelChange,
  triggerAutomation,
  chatThreadId,
}: ChatUIProps) {
  const [hasMessages, setHasMessages] = useState(chatHelpers.messages.length > 0)
  const [input, setInput] = useState('')
  const [showOverflowModal, setShowOverflowModal] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const previousMessageCountRef = useRef(chatHelpers.messages.length)
  const navigate = useNavigate()
  const { isMobile, isReady } = useIsMobile()

  const selectedModel = models.find((m) => m.id === selectedModelId) || models[0]

  const { usedTokens, maxTokens, isContextKnown, isOverflowing } = useContextTracking({
    model: selectedModel,
    chatThreadId,
    currentInput: input,
    onOverflow: () => setShowOverflowModal(true),
  })

  const { data: chatThread = null } = useQuery({
    queryKey: ['chatThreads', chatThreadId],
    queryFn: () => getChatThread(chatThreadId),
  })

  // Extract prompt from the first message (automation prompt) for trigger display
  const triggerPromptContent =
    triggerAutomation?.wasTriggeredByAutomation && chatHelpers.messages[0]?.parts?.[0]?.type === 'text'
      ? chatHelpers.messages[0].parts[0].text
      : undefined

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

  const isStreaming = chatHelpers.status === 'streaming'

  const handleSubmit = async () => {
    // Prevent submitting while streaming or if input is empty
    const textToSend = input.trim()
    if (isStreaming || !textToSend) return

    // Validate encryption state
    if (chatThread && chatThread.isEncrypted !== selectedModel?.isConfidential) {
      throw new Error(
        `This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`,
      )
    }

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

    await chatHelpers.sendMessage({ text: textToSend, metadata: { modelId: selectedModelId } })

    // Reset user scroll state and scroll to bottom when submitting a new message
    resetUserScroll()
    requestAnimationFrame(() => {
      scrollToBottom()
    })
  }

  useEffect(() => {
    if (!hasMessages) return

    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        scrollToBottom()
      })
    })

    return () => cancelAnimationFrame(frame)
  }, [hasMessages])

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
            {chatThread?.isEncrypted === 1 && <EncryptionMessage />}
            {/* Automation trigger banner */}
            {triggerAutomation?.wasTriggeredByAutomation && (
              <TriggerMessage
                chatThreadId={chatThreadId}
                title={triggerAutomation.prompt?.title ?? undefined}
                prompt={triggerPromptContent}
                isDeleted={triggerAutomation.isAutomationDeleted}
              />
            )}

            {chatHelpers.messages.map((message, i) => {
              // Skip the very first user message if it was the automation prompt (already shown above)
              if (triggerAutomation?.wasTriggeredByAutomation && i === 0) {
                return null
              }

              if (message.role === 'assistant') {
                return (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    isStreaming={isStreaming && i === chatHelpers.messages.length - 1}
                  />
                )
              } else if (message.role === 'user') {
                return <UserMessage key={message.id} message={message} />
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
  )
}
