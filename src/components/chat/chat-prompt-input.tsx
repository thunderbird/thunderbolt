import { useCurrentChatSession, useChatStore } from '@/chats/chat-store'
import { useAcpChatActions } from '@/chats/use-acp-chat'
import { extractModelConfig, modelFromConfigOption, modeFromSessionMode } from '@/acp/session-adapters'
import { useHaptics } from '@/hooks/use-haptics'
import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { useIsMobile as useIsMobile_default } from '@/hooks/use-mobile'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { type Model, type SaveMessagesFunction } from '@/types'
import { useDraftInput } from '@/hooks/use-draft-input'
import { AlertCircle, Loader2 } from 'lucide-react'
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useNavigate as useNavigate_default } from 'react-router'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { ModeSelector } from '../ui/mode-selector'
import { PromptInput } from '../ui/prompt-input'

/**
 * Extract a human-readable display string from a connection error.
 * Handles JSON-RPC error messages (which have nested data.message),
 * plain strings, and generic Error objects.
 */
const extractErrorDisplay = (error: Error | null | undefined): string => {
  if (!error?.message) {
    return 'Connection failed'
  }

  // Try to parse as JSON-RPC error (e.g. from ACP agents)
  try {
    const parsed = JSON.parse(error.message)
    // Prefer the nested data.message (most specific), fall back to top-level message
    const message = parsed?.data?.message ?? parsed?.data?.details ?? parsed?.message
    if (typeof message === 'string') {
      return message
    }
  } catch {
    // Not JSON — use the raw message
  }

  return error.message
}

export type ChatPromptInputRef = {
  focus: () => void
  setInput: (text: string) => void
}

type ChatPromptInputProps = {
  useNavigate?: typeof useNavigate_default
  useContextTracking?: typeof useContextTracking_default
  trackEvent?: typeof trackEvent_default
  useIsMobile?: typeof useIsMobile_default
  saveMessages?: SaveMessagesFunction
}

export const ChatPromptInput = forwardRef<ChatPromptInputRef, ChatPromptInputProps>(
  (
    {
      useNavigate = useNavigate_default,
      useContextTracking = useContextTracking_default,
      trackEvent = trackEvent_default,
      useIsMobile = useIsMobile_default,
      saveMessages: saveMessagesProp,
    },
    ref,
  ) => {
    const navigate = useNavigate()
    const setSelectedMode = useChatStore((state) => state.setSelectedMode)

    const { isMobile } = useIsMobile()

    const {
      chatThread,
      id: chatThreadId,
      selectedMode,
      selectedModel,
      messages,
      status,
      error,
      availableModes,
      configOptions,
      isAgentAvailable,
      agentConfig,
    } = useCurrentChatSession()

    const modes = useMemo(
      () =>
        availableModes.map((m) =>
          modeFromSessionMode(m, selectedMode.id === m.id ? selectedMode.icon : 'message-square'),
        ),
      [availableModes, selectedMode.id, selectedMode.icon],
    )

    const { sendMessage, stop } = useAcpChatActions(saveMessagesProp)

    const isStreaming = status === 'streaming'
    const isConnecting = status === 'connecting'
    const isConnectionError = status === 'error' && modes.length === 0 && error != null

    // isMobile = viewport is narrow (responsive breakpoint, e.g. desktop browser resized small)
    // isPlatformMobile() = native platform is iOS/Android (Tauri mobile app)
    // Either condition means we prefer mobile-style input where Enter inserts a newline.
    const shouldInsertNewlineOnEnter = isMobile || isPlatformMobile()

    // Use a stable "new" key for unsaved chats so the draft persists across /chats/new navigations
    const draftKey = chatThread ? chatThreadId : 'new'
    const [showOverflowModal, setShowOverflowModal] = useState(false)
    const isNewChat = !chatThread
    const [input, setInput, clearDraft] = useDraftInput(draftKey, { persist: !isNewChat })
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

    const modelConfigResult = useMemo(() => extractModelConfig(configOptions), [configOptions])

    const acpModels: Model[] = useMemo(
      () => (modelConfigResult?.options ?? []).map(modelFromConfigOption),
      [modelConfigResult],
    )

    const acpSelectedModel = useMemo(
      () => acpModels.find((m) => m.id === modelConfigResult?.currentValue) ?? null,
      [acpModels, modelConfigResult],
    )

    const handleModelChange = useCallback(
      (modelId: string) => {
        triggerSelection()
        useChatStore.getState().setSelectedModel(chatThreadId, modelId).catch(console.error)
      },
      [chatThreadId, triggerSelection],
    )

    const footerStartElements = (
      <div className="flex items-center gap-2">
        {isConnecting && modes.length === 0 ? (
          <div className="flex items-center gap-2 px-3 h-[var(--touch-height-sm)] text-muted-foreground text-[length:var(--font-size-body)]">
            <Loader2 className="size-[var(--icon-size-default)] shrink-0 animate-spin" />
            <span>Connecting to {agentConfig.name}...</span>
          </div>
        ) : isConnectionError ? (
          <div className="flex items-center gap-2 px-3 h-[var(--touch-height-sm)] text-destructive text-[length:var(--font-size-body)]">
            <AlertCircle className="size-[var(--icon-size-default)] shrink-0" />
            <span className="truncate" title={extractErrorDisplay(error)}>
              Failed to connect to {agentConfig.name}
            </span>
          </div>
        ) : (
          modes.length > 0 && <ModeSelector modes={modes} selectedMode={selectedMode} onModeChange={handleModeChange} />
        )}
        {isContextKnown && !isMobile && (
          <ContextUsageIndicator usedTokens={usedTokens ?? 0} maxTokens={maxTokens ?? 0} />
        )}
      </div>
    )

    // Agent not available on this platform — show read-only message
    if (!isAgentAvailable) {
      return (
        <div className="flex items-center justify-center px-4 py-3 text-muted-foreground text-[length:var(--font-size-sm)]">
          <span>
            This chat uses {agentConfig.name} ({agentConfig.type === 'local' ? 'desktop only' : 'unavailable'})
          </span>
        </div>
      )
    }

    return (
      <>
        <PromptInput
          ref={formRef}
          value={input}
          onChange={(value: string) => setInput(value)}
          placeholder="Ask me anything..."
          showSubmitButton
          onSubmit={handleSubmit}
          isLoading={isStreaming || isConnecting}
          isStreaming={isStreaming}
          onStop={stop}
          autoFocus={!isMobile}
          submitOnEnter={!isStreaming && !shouldInsertNewlineOnEnter}
          className="flex flex-col w-full gap-0 p-2"
          footerStartElements={footerStartElements}
          chatThread={chatThread}
          models={acpModels.length > 1 ? acpModels : undefined}
          selectedModel={acpSelectedModel}
          onModelChange={acpModels.length > 1 ? handleModelChange : undefined}
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
