import { useContextTracking } from '@/hooks/use-context-tracking'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { PromptInput } from '../ui/prompt-input'
import { type Model } from '@/types'
import { ContextOverflowModal } from '../context-overflow-modal'
import { useNavigate } from 'react-router'
import { trackEvent } from '@/lib/posthog'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat } from '@ai-sdk/react'
import { useSidebar } from '../ui/sidebar'

export type ChatPromptInputRef = {
  focus: () => void
  setInput: (text: string) => void
}

type ChatPromptInputProps = {
  handleResetUserScroll(): void
  handleScrollToBottom(): void
}

export const ChatPromptInput = forwardRef<ChatPromptInputRef, ChatPromptInputProps>(
  ({ handleResetUserScroll, handleScrollToBottom }, ref) => {
    const navigate = useNavigate()

    const { chatInstance, chatThread, chatThreadId, models, sendMessage, selectedModel, setSelectedModel } =
      useChatStore(
        useShallow((state) => ({
          chatInstance: state.chatInstance!,
          chatThread: state.chatThread,
          chatThreadId: state.id!,
          models: state.models,
          sendMessage: state.sendMessage,
          selectedModel: state.selectedModel!,
          setSelectedModel: state.setSelectedModel,
        })),
      )

    const { messages, status, stop } = useChat({ chat: chatInstance })

    const isStreaming = status === 'streaming'

    const [showOverflowModal, setShowOverflowModal] = useState(false)
    const [input, setInput] = useState('')
    const formRef = useRef<HTMLFormElement>(null)

    const { usedTokens, maxTokens, isContextKnown, isOverflowing } = useContextTracking({
      model: selectedModel,
      chatThreadId,
      currentInput: input,
      onOverflow: () => handleShowOverflowModal(selectedModel, input.trim().length, messages.length + 1),
    })

    const handleSubmit = async () => {
      // Prevent submitting while streaming or if input is empty
      const textToSend = input.trim()
      if (isStreaming || !textToSend) return

      if (isOverflowing) {
        handleShowOverflowModal(selectedModel, textToSend.length, messages.length + 1)
        return
      }

      // Clear the input immediately for responsive UX
      setInput('')

      await sendMessage(textToSend)

      // Reset user scroll state and scroll to bottom when submitting a new message
      handleResetUserScroll()
      requestAnimationFrame(() => {
        handleScrollToBottom()
      })
    }

    const handleNewChat = async () => {
      await navigate('/chats/new')
    }

    const handleShowOverflowModal = useCallback((model: Model, length: number, prompt_number: number) => {
      setShowOverflowModal(true)
      trackEvent('chat_send_prompt_overflow', {
        model,
        length,
        prompt_number,
      })
    }, [])

    const { isMobile, openMobile } = useSidebar()

    /**
     * This ensures that the textarea is focused when the mobile sidebar is closed.
     * Before the textarea was focused when the mobile sidebar was open.
     */
    useEffect(() => {
      let timeout: any = null

      if (isMobile && !openMobile) {
        const textareaElement = formRef.current?.querySelector('textarea')
        // wait sidebar to be closed, so layout is stable
        timeout = setTimeout(() => {
          textareaElement?.focus()
        }, 500)
      }

      return () => {
        if (timeout) {
          clearTimeout(timeout)
        }
      }
    }, [isMobile, openMobile])

    useImperativeHandle(ref, () => ({
      focus: () => {
        const textareaElement = formRef.current?.querySelector('textarea')
        textareaElement?.focus()

        // Set the cursor position to the end of the text
        const textLength = textareaElement?.value.length ?? 0
        textareaElement?.setSelectionRange(textLength, textLength)
      },
      setInput,
    }))

    return (
      <>
        <PromptInput
          ref={formRef}
          chatThread={chatThread}
          value={input}
          onChange={(value: string) => setInput(value)}
          placeholder="Say something..."
          models={models}
          selectedModelId={selectedModel.id}
          onModelChange={setSelectedModel}
          showSubmitButton
          onSubmit={handleSubmit}
          isLoading={isStreaming}
          isStreaming={isStreaming}
          onStop={stop}
          autoFocus={!isMobile}
          submitOnEnter={!isStreaming}
          className="flex flex-col gap-2 bg-secondary p-4 rounded-md w-full"
          footerStartElements={
            isContextKnown && <ContextUsageIndicator usedTokens={usedTokens ?? 0} maxTokens={maxTokens ?? 0} />
          }
        />
        <ContextOverflowModal
          isOpen={showOverflowModal}
          onClose={() => setShowOverflowModal(false)}
          maxTokens={maxTokens ?? undefined}
          onNewChat={handleNewChat}
        />
      </>
    )
  },
)
