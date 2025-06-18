import { useAutoScroll } from '@/hooks/use-auto-scroll'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { Model } from '@/types'
import type { UseChatHelpers } from '@ai-sdk/react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Lock } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AgentToolResponse } from './agent-tool-response'
import { ChatLoadingIndicator } from './chat-loading-indicator'
import { Reasoning } from './reasoning'
import { StreamingMarkdown } from './streaming-markdown'

interface ChatUIProps {
  chatHelpers: UseChatHelpers
  models: Model[]
  selectedModel: string | null
  onModelChange: (model: string | null) => void
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
    { label: 'Write a message', prompt: 'Write a thank you email to my coworker for helping with the meeting yesterday.' },
    { label: 'Understand a topic', prompt: 'Explain how checks and balances work between the three branches of government.' },
  ]

  return (
    <div className="flex flex-wrap gap-2 justify-center mt-4 w-full max-w-[696px] mx-auto">
      {suggestions.map((suggestion, index) => (
        <SuggestionButton key={index} label={suggestion.label} prompt={suggestion.prompt} onSelect={onSelectPrompt} />
      ))}
    </div>
  )
}

export default function ChatUI({ chatHelpers, models, selectedModel, onModelChange }: ChatUIProps) {
  const [hasMessages, setHasMessages] = useState(chatHelpers.messages.length > 0)
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const previousMessageCountRef = useRef(chatHelpers.messages.length)
  const isMobile = useIsMobile()

  const { scrollContainerRef, scrollTargetRef, scrollToBottom, resetUserScroll, scrollHandlers, userHasScrolled, isAtBottom } = useAutoScroll({
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
    } else if (chatHelpers.status === 'streaming' && !userHasScrolled && isAtBottom) {
      // Continue scrolling during streaming only if user hasn't scrolled away AND we're at bottom
      scrollToBottom()
    }

    previousMessageCountRef.current = currentMessageCount
    setHasMessages(currentMessageCount > 0)
  }, [chatHelpers.messages, chatHelpers.status, scrollToBottom, resetUserScroll, userHasScrolled, isAtBottom])

  // Detect keyboard visibility on mobile
  useEffect(() => {
    if (!isMobile) return

    let timeout: NodeJS.Timeout
    const inputElement = formRef.current?.querySelector('input')

    const handleFocus = (e: FocusEvent) => {
      if (e.target === inputElement) {
        setIsKeyboardVisible(true)
        // Scroll the input into view after a small delay
        timeout = setTimeout(() => {
          inputElement?.scrollIntoView({ behavior: 'smooth', block: 'end' })
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

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    chatHelpers.handleSubmit(e)
    // Reset user scroll state and scroll to bottom when submitting a new message
    resetUserScroll()
    setTimeout(() => scrollToBottom(), 100)
  }

  const handleSelectPrompt = (prompt: string) => {
    chatHelpers.setInput(prompt)
    setTimeout(() => {
      const inputElement = formRef.current?.querySelector('input')
      if (inputElement) {
        inputElement.focus()
      }
    }, 0)
  }

  return (
    <div className={cn('flex flex-col h-full bg-background overflow-hidden w-full max-w-[728px] mx-auto min-w-[300px]', isMobile && isKeyboardVisible && 'pb-0')}>
      <AnimatePresence>
        {hasMessages && (
          <motion.div ref={scrollContainerRef} {...scrollHandlers} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 p-4 overflow-y-auto space-y-4">
            {chatHelpers.messages.map((message, i) => {
              if (message.role === 'assistant') {
                return (
                  <div key={i} className="space-y-2 p-4 rounded-md bg-secondary mr-auto">
                    {message.parts
                      .filter((part) => part.type === 'tool-invocation')
                      .map((part, j) => (
                        <AgentToolResponse key={j} part={part} />
                      ))}
                    {message.parts
                      .filter((part) => part.type === 'reasoning')
                      .map((part, j) => (
                        <Reasoning key={j} text={part.text} />
                      ))}
                    {message.parts
                      .filter((part) => part.type === 'text')
                      .map((part, j) => (
                        <StreamingMarkdown
                          key={j}
                          content={part.text}
                          isStreaming={chatHelpers.status === 'streaming' && i === chatHelpers.messages.length - 1}
                          className="text-secondary-foreground leading-relaxed"
                        />
                      ))}
                  </div>
                )
              } else if (message.role === 'user') {
                return message.parts
                  .filter((part) => part.type === 'text')
                  .map((part, j) => (
                    <div key={j} className="p-4 rounded-md max-w-3/4 bg-primary text-primary-foreground ml-auto">
                      <div className="space-y-2">
                        <div className="text-primary-foreground leading-relaxed">{part.text}</div>
                      </div>
                    </div>
                  ))
              }
              return null
            })}

            {/* Show loading indicator when waiting for server response */}
            {chatHelpers.status === 'submitted' && <ChatLoadingIndicator />}

            {/* Show error message if there's an error */}
            {chatHelpers.error && (
              <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20 mr-auto">
                <p className="text-destructive font-medium mb-1">Error</p>
                <p className="text-destructive/80 text-sm">{chatHelpers.error.message || 'An unexpected error occurred. Please try again.'}</p>
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
          <motion.form
            ref={formRef}
            onSubmit={handleSubmit}
            className="flex flex-col gap-2 bg-secondary p-4 rounded-md w-full max-w-[696px] min-w-[268px]"
            layout
            transition={{
              type: 'tween',
              ease: [0.2, 0.9, 0.1, 1],
              duration: 0.25,
            }}
          >
            <Input variant="ghost" autoFocus value={chatHelpers.input} onChange={chatHelpers.handleInputChange} placeholder="Say something..." className="flex-1 px-4 py-2" />
            <div className="flex gap-2 justify-end items-center w-full">
              <Select value={selectedModel || ''} onValueChange={onModelChange}>
                <SelectTrigger className="rounded-full" size="sm">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      <div className="flex items-center gap-2">
                        {model.isConfidential ? <Lock className="size-3.5" /> : null}
                        <p className="text-left">{model.name}</p>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" variant="default" className="h-6 w-6 rounded-full flex items-center justify-center">
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </motion.form>

          {!hasMessages && !(isMobile && isKeyboardVisible) && (
            <AnimatePresence>
              <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ delay: 0.1 }} className="w-full overflow-x-auto pb-2">
                <SuggestionButtons onSelectPrompt={handleSelectPrompt} />
              </motion.div>
            </AnimatePresence>
          )}
        </motion.div>
      </motion.div>
    </div>
  )
}
