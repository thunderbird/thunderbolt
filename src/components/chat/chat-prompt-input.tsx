/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession, useChatStore } from '@/chats/chat-store'
import { useHaptics } from '@/hooks/use-haptics'
import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { useIsMobile as useIsMobile_default } from '@/hooks/use-mobile'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { type Model } from '@/types'
import { useChat as useChat_default } from '@ai-sdk/react'
import { useDraftInput } from '@/hooks/use-draft-input'
import { Plus } from 'lucide-react'
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate as useNavigate_default } from 'react-router'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { renderHighlightedSkillTokens } from '@/skills/highlight-skill-tokens'
import { ReorderPanel } from '@/skills/reorder-panel'
import { SlashPopup } from '@/skills/slash-popup'
import { SuggestionChip } from '@/skills/suggestion-chip'
import { useEnabledSkills, useLibrarySkills, usePinnedSkills, useRecentSkills } from '@/skills/use-skills-placeholder'
import { useSlashCommand } from '@/skills/use-slash-command'
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
    const isNewChat = !chatThread
    const [input, setInput, clearDraft] = useDraftInput(draftKey, { persist: !isNewChat })
    const formRef = useRef<HTMLFormElement>(null)
    const { triggerSelection } = useHaptics()

    // Skill UX state
    const [openChip, setOpenChip] = useState<string | null>(null)
    const [reorderMode, setReorderMode] = useState(false)
    const { pinned, movePinned, togglePin } = usePinnedSkills()
    const { skills: library } = useLibrarySkills()
    const { isEnabled } = useEnabledSkills()
    const { recent, recordUsed } = useRecentSkills()
    const skillNames = useMemo(() => new Set(library.map((s) => s.name)), [library])
    const isValidSkill = useCallback(
      (token: string) => skillNames.has(token) && isEnabled(token),
      [skillNames, isEnabled],
    )

    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const getTextarea = () => {
      textareaRef.current = formRef.current?.querySelector('textarea') ?? null
      return textareaRef.current
    }
    const slashInputRef = { current: getTextarea() }

    const {
      setCursorPos,
      popupSkills,
      popupOpen,
      highlightedIdx,
      setHighlightedIdx,
      selectSkill: selectSkillFromPopup,
      handleKeyDown: handleSlashKeyDown,
    } = useSlashCommand({
      value: input,
      setValue: setInput,
      inputRef: slashInputRef,
      library,
      isEnabled,
      recent,
      recordUsed,
    })

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

    const addSkillChip = (name: string) => {
      const trimmed = input.trim()
      const onlyHoldsSkill = trimmed.length > 0 && skillNames.has(trimmed)
      const next = input.length === 0 || onlyHoldsSkill ? `${name} ` : `${input.replace(/\s+$/, '')} ${name} `
      setInput(next)
      recordUsed(name)
      requestAnimationFrame(() => {
        const ta = getTextarea()
        ta?.focus()
        ta?.setSelectionRange(next.length, next.length)
        setCursorPos(next.length)
      })
    }

    const insertInstructionText = (text: string) => {
      const ta = getTextarea()
      const start = ta?.selectionStart ?? input.length
      const end = ta?.selectionEnd ?? input.length
      const needsSpace = start > 0 && input[start - 1] !== ' '
      const insert = needsSpace ? ` ${text}` : text
      const next = input.slice(0, start) + insert + input.slice(end)
      setInput(next)
      requestAnimationFrame(() => {
        const focused = getTextarea()
        focused?.focus()
        const pos = start + insert.length
        focused?.setSelectionRange(pos, pos)
      })
    }

    const suggestions = pinned

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

    const showSkillOverlay = isMobile && (openChip !== null || reorderMode)

    return (
      <>
        {showSkillOverlay &&
          createPortal(
            <div
              className="fixed inset-0 z-[5] bg-black/30 backdrop-blur-sm"
              aria-hidden="true"
              onClick={() => {
                setOpenChip(null)
                setReorderMode(false)
              }}
            />,
            document.body,
          )}
        <div className="flex w-full flex-col gap-3">
          {reorderMode ? (
            <ReorderPanel skills={suggestions} onMove={movePinned} onClose={() => setReorderMode(false)} />
          ) : suggestions.length > 0 ? (
            <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
              {suggestions.map((name) => {
                const skill = library.find((s) => s.name === name)
                return (
                  <SuggestionChip
                    key={name}
                    label={name}
                    dimmed={openChip !== null && openChip !== name}
                    onClick={() => addSkillChip(name)}
                    onOpenChange={(open) => setOpenChip(open ? name : null)}
                    runHref={`/?run=${encodeURIComponent(name)}`}
                    onAddInstruction={() => insertInstructionText(skill?.instruction ?? name)}
                    onReorder={() => setReorderMode(true)}
                    onUnpin={() => togglePin(name)}
                  />
                )
              })}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    variant="outline"
                    size="icon-sm"
                    aria-label="Manage skills"
                    className={`size-8 shrink-0 rounded-full bg-card transition-opacity ${
                      openChip ? 'opacity-40' : ''
                    }`}
                  >
                    <Link to="/settings/skills">
                      <Plus />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Pin skills for quick access</TooltipContent>
              </Tooltip>
            </div>
          ) : null}

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
            className="flex flex-col w-full gap-0 p-3 bg-card border rounded-xl"
            footerStartElements={footerStartElements}
            renderOverlay={(value) => renderHighlightedSkillTokens(value, isValidSkill)}
            popoverSlot={
              popupOpen ? (
                <SlashPopup
                  skills={popupSkills}
                  highlightedIdx={highlightedIdx}
                  onSelect={selectSkillFromPopup}
                  onHover={setHighlightedIdx}
                />
              ) : null
            }
            onTextareaKeyDown={handleSlashKeyDown}
            onTextareaSelect={(e) => setCursorPos(e.currentTarget.selectionStart)}
          />
        </div>
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
