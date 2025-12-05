import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { PromptInput } from '../ui/prompt-input'
import { type Model } from '@/types'
import { ContextOverflowModal } from '../context-overflow-modal'
import { useNavigate as useNavigate_default } from 'react-router'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { useChatStore } from '@/chats/chat-store'
import { useShallow } from 'zustand/react/shallow'
import { useChat as useChat_default } from '@ai-sdk/react'
import { useSidebar as useSidebar_default } from '../ui/sidebar'
import { useSettings } from '@/hooks/use-settings'

export type ChatPromptInputRef = {
  focus: () => void
  setInput: (text: string) => void
}

type ChatPromptInputProps = {
  handleResetUserScroll(): void
  handleScrollToBottom(): void
  useNavigate?: typeof useNavigate_default
  useChat?: typeof useChat_default
  useContextTracking?: typeof useContextTracking_default
  trackEvent?: typeof trackEvent_default
  useSidebar?: typeof useSidebar_default
}

export const ChatPromptInput = forwardRef<ChatPromptInputRef, ChatPromptInputProps>(
  (
    {
      handleResetUserScroll,
      handleScrollToBottom,
      useNavigate = useNavigate_default,
      useChat = useChat_default,
      useContextTracking = useContextTracking_default,
      trackEvent = trackEvent_default,
      useSidebar = useSidebar_default,
    },
    ref,
  ) => {
    const navigate = useNavigate()

    const { chatInstance, chatThreadId, selectedModel } = useChatStore(
      useShallow((state) => ({
        chatInstance: state.chatInstance!,
        chatThreadId: state.id!,
        selectedModel: state.selectedModel!,
      })),
    )

    const { messages, status, stop, sendMessage } = useChat({ chat: chatInstance })

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
      try {
        // Prevent submitting while streaming or if input is empty
        const textToSend = input.trim()
        if (isStreaming || !textToSend) return

        if (isOverflowing) {
          handleShowOverflowModal(selectedModel, textToSend.length, messages.length + 1)
          return
        }

        // Clear the input immediately for responsive UX
        setInput('')

        await sendMessage({ text: textToSend })

        // Reset user scroll state and scroll to bottom when submitting a new message
        handleResetUserScroll()
        requestAnimationFrame(() => {
          handleScrollToBottom()
        })
      } catch (error) {
        console.error('Error submitting message:', error)
      }
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

    const { userHasCompletedOnboarding } = useSettings({
      user_has_completed_onboarding: false,
    })

    useEffect(() => {
      let timeout: ReturnType<typeof setTimeout> | null = null

      if (isMobile && !openMobile && userHasCompletedOnboarding.value) {
        const textareaElement = formRef.current?.querySelector('textarea')
        timeout = setTimeout(() => {
          textareaElement?.focus()
        }, 500)
      }

      return () => {
        if (timeout) {
          clearTimeout(timeout)
        }
      }
    }, [isMobile, openMobile, userHasCompletedOnboarding.value])

    useImperativeHandle(ref, () => ({
      focus: () => {
        const textareaElement = formRef.current?.querySelector('textarea')
        textareaElement?.focus()

        const textLength = textareaElement?.value.length ?? 0
        textareaElement?.setSelectionRange(textLength, textLength)
      },
      setInput,
    }))

    return (
      <>
        <PromptInput
          ref={formRef}
          value={input}
          onChange={(value: string) => setInput(value)}
          placeholder="Say something..."
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
