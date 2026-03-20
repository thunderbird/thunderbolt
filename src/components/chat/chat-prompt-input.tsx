import { useCurrentChatSession, useChatStore } from '@/chats/chat-store'
import { useHaptics } from '@/hooks/use-haptics'
import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { useIsMobile as useIsMobile_default } from '@/hooks/use-mobile'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { type Model } from '@/types'
import { useChat as useChat_default } from '@ai-sdk/react'
import { useDraftInput } from '@/hooks/use-draft-input'
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { useNavigate as useNavigate_default } from 'react-router'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { ModeSelector } from '../ui/mode-selector'
import { PromptInput } from '../ui/prompt-input'

export type ChatPromptInputRef = {
  focus: () => void
  setInput: (text: string) => void
}

type ChatPromptInputProps = {
  useNavigate?: typeof useNavigate_default
  useChat?: typeof useChat_default
  useContextTracking?: typeof useContextTracking_default
  trackEvent?: typeof trackEvent_default
  useIsMobile?: typeof useIsMobile_default
}

export const ChatPromptInput = forwardRef<ChatPromptInputRef, ChatPromptInputProps>(
  (
    {
      useNavigate = useNavigate_default,
      useChat = useChat_default,
      useContextTracking = useContextTracking_default,
      trackEvent = trackEvent_default,
      useIsMobile = useIsMobile_default,
    },
    ref,
  ) => {
    const navigate = useNavigate()
    const modes = useChatStore((state) => state.modes)
    const setSelectedMode = useChatStore((state) => state.setSelectedMode)

    const { isMobile } = useIsMobile()

    const { chatInstance, chatThread, id: chatThreadId, selectedMode, selectedModel } = useCurrentChatSession()

    const { messages, status, stop, sendMessage } = useChat({ chat: chatInstance })

    const isStreaming = status === 'streaming'

    // isMobile = viewport is narrow (responsive breakpoint, e.g. desktop browser resized small)
    // isPlatformMobile() = native platform is iOS/Android (Tauri mobile app)
    // Either condition means we prefer mobile-style input where Enter inserts a newline.
    const shouldInsertNewlineOnEnter = isMobile || isPlatformMobile()

    // Use a stable "new" key for unsaved chats so the draft persists across /chats/new navigations
    const draftKey = chatThread ? chatThreadId : 'new'
    const [showOverflowModal, setShowOverflowModal] = useState(false)
    const [input, setInput, clearDraft] = useDraftInput(draftKey)
    const formRef = useRef<HTMLFormElement>(null)
    const { triggerSelection } = useHaptics()

    const handleModeChange = useCallback(
      (modeId: string) => {
        triggerSelection()
        setSelectedMode(chatThreadId, modeId).catch(console.error)
      },
      [chatThreadId, setSelectedMode, triggerSelection],
    )

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
        if (isStreaming || !textToSend) {
          return
        }

        if (isOverflowing) {
          handleShowOverflowModal(selectedModel, textToSend.length, messages.length + 1)
          return
        }

        // Clear input and persisted draft immediately for responsive UX
        clearDraft()

        await sendMessage({ text: textToSend })
      } catch (error) {
        console.error('Error submitting message:', error)
      }
    }

    const handleNewChat = async () => {
      await navigate('/chats/new')
    }

    const handleShowOverflowModal = useCallback(
      (model: Model, length: number, prompt_number: number) => {
        setShowOverflowModal(true)
        trackEvent('chat_send_prompt_overflow', {
          model,
          length,
          prompt_number,
        })
      },
      [trackEvent],
    )

    useImperativeHandle(ref, () => ({
      focus: () => {
        const textareaElement = formRef.current?.querySelector('textarea')
        textareaElement?.focus()

        const textLength = textareaElement?.value.length ?? 0
        textareaElement?.setSelectionRange(textLength, textLength)
      },
      setInput,
    }))

    const footerStartElements = (
      <div className="flex items-center gap-2">
        {modes.length > 0 && (
          <ModeSelector modes={modes} selectedMode={selectedMode} onModeChange={handleModeChange} iconOnly={isMobile} />
        )}
        {isContextKnown && !isMobile && (
          <ContextUsageIndicator usedTokens={usedTokens ?? 0} maxTokens={maxTokens ?? 0} />
        )}
      </div>
    )

    return (
      <>
        <PromptInput
          ref={formRef}
          value={input}
          onChange={(value: string) => setInput(value)}
          placeholder="Ask me anything..."
          showSubmitButton
          onSubmit={handleSubmit}
          isLoading={isStreaming}
          isStreaming={isStreaming}
          onStop={stop}
          autoFocus={!isMobile}
          submitOnEnter={!isStreaming && !shouldInsertNewlineOnEnter}
          className="flex flex-col w-full gap-0 p-2"
          footerStartElements={footerStartElements}
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
