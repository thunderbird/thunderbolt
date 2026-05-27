/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCurrentChatSession, useChatStore } from '@/chats/chat-store'
import { estimateTokensForText } from '@/ai/tokenizers'
import { useHaptics } from '@/hooks/use-haptics'
import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { useIsMobile as useIsMobile_default } from '@/hooks/use-mobile'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { renderHighlightedSkillTokens } from '@/skills/highlight-skill-tokens'
import { findSkillTokens } from '@/skills/parse-skill-tokens'
import { SlashPopup } from '@/skills/slash-popup'
import { useSlashCommand } from '@/skills/use-slash-command'
import {
  useEnabledSkills as useEnabledSkills_default,
  useLibrarySkills as useLibrarySkills_default,
} from '@/skills/use-skills'
import { type Model } from '@/types'
import { useChat as useChat_default } from '@ai-sdk/react'
import { useDraftInput } from '@/hooks/use-draft-input'
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useLocation as useLocation_default, useNavigate as useNavigate_default } from 'react-router'
import { ChatSkillsBar } from './chat-skills-bar'
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
  useLocation?: typeof useLocation_default
  useChat?: typeof useChat_default
  useContextTracking?: typeof useContextTracking_default
  trackEvent?: typeof trackEvent_default
  useIsMobile?: typeof useIsMobile_default
  useLibrarySkills?: typeof useLibrarySkills_default
  useEnabledSkills?: typeof useEnabledSkills_default
}

export const ChatPromptInput = forwardRef<ChatPromptInputRef, ChatPromptInputProps>(
  (
    {
      useNavigate = useNavigate_default,
      useLocation = useLocation_default,
      useChat = useChat_default,
      useContextTracking = useContextTracking_default,
      trackEvent = trackEvent_default,
      useIsMobile = useIsMobile_default,
      useLibrarySkills = useLibrarySkills_default,
      useEnabledSkills = useEnabledSkills_default,
    },
    ref,
  ) => {
    const navigate = useNavigate()
    const location = useLocation()
    const modes = useChatStore((state) => state.modes)
    const setSelectedMode = useChatStore((state) => state.setSelectedMode)

    const { isMobile } = useIsMobile()

    const { chatInstance, chatThread, id: chatThreadId, selectedMode, selectedModel } = useCurrentChatSession()

    const { messages, status, stop, sendMessage } = useChat({ chat: chatInstance })

    const { skills: library } = useLibrarySkills()
    const { isEnabled } = useEnabledSkills()
    const enabledSlugs = useMemo(
      () => new Set(library.filter((s) => isEnabled(s.id)).map((s) => s.name)),
      [library, isEnabled],
    )
    const isValidSkillSlug = useCallback((slug: string) => enabledSlugs.has(slug), [enabledSlugs])

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
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const { triggerSelection } = useHaptics()

    const getTextarea = (): HTMLTextAreaElement | null => {
      textareaRef.current = formRef.current?.querySelector('textarea') ?? null
      return textareaRef.current
    }

    const slashInputRef = useRef<HTMLTextAreaElement | null>(null)
    slashInputRef.current = getTextarea()

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
      isEnabled: isValidSkillSlug,
    })

    const addSkillChip = useCallback(
      (slug: string) => {
        const trimmed = input.trim()
        const token = `/${slug}`
        const onlyHoldsSkill = trimmed === token
        const next = input.length === 0 || onlyHoldsSkill ? `${token} ` : `${input.replace(/\s+$/, '')} ${token} `
        setInput(next)
        requestAnimationFrame(() => {
          const ta = getTextarea()
          ta?.focus()
          ta?.setSelectionRange(next.length, next.length)
          setCursorPos(next.length)
        })
      },
      [input, setInput, setCursorPos],
    )

    const insertInstructionText = useCallback(
      (text: string) => {
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
          setCursorPos(pos)
        })
      },
      [input, setInput, setCursorPos],
    )

    // Run-in-chat router-state nav (Skills v1 §5). Read once during render
    // and clear the state via `navigate(replace)` so back/forward doesn't
    // re-trigger. Tracked via `consumedRunSkillRef` so React's StrictMode
    // double-render doesn't insert the token twice.
    const consumedRunSkillRef = useRef<string | null>(null)
    const runSkill = (location.state as { runSkill?: string } | null)?.runSkill
    if (runSkill && consumedRunSkillRef.current !== runSkill) {
      consumedRunSkillRef.current = runSkill
      // Defer setState until after render to avoid setState-in-render warnings.
      queueMicrotask(() => {
        addSkillChip(runSkill)
        navigate(location.pathname, { replace: true, state: {} })
        trackEvent('skill_used', { via: 'settings-nav' })
      })
    }

    const handleModeChange = useCallback(
      (modeId: string) => {
        triggerSelection()
        setSelectedMode(chatThreadId, modeId).catch(console.error)
      },
      [chatThreadId, setSelectedMode, triggerSelection],
    )

    // Estimate the token cost of resolved skill instructions so the
    // overflow modal fires correctly when /name tokens push the send past
    // the model's context window — Skills v1 Open Q #5.
    const additionalInputTokens = useMemo(() => {
      const tokens = findSkillTokens(input)
      const seen = new Set<string>()
      let total = 0
      for (const { slug } of tokens) {
        if (seen.has(slug) || !enabledSlugs.has(slug)) {
          continue
        }
        seen.add(slug)
        const skill = library.find((s) => s.name === slug)
        if (skill) {
          total += estimateTokensForText(skill.instruction)
        }
      }
      return total
    }, [input, enabledSlugs, library])

    const { usedTokens, maxTokens, isContextKnown, isOverflowing } = useContextTracking({
      model: selectedModel,
      chatThreadId,
      currentInput: input,
      additionalInputTokens,
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

    const handleAddChipFromBar = useCallback(
      (slug: string) => {
        addSkillChip(slug)
        trackEvent('skill_used', { via: 'chip' })
      },
      [addSkillChip, trackEvent],
    )

    const handleSelectFromSlashPopup = useCallback(
      (skill: Parameters<typeof selectSkillFromPopup>[0]) => {
        selectSkillFromPopup(skill)
        trackEvent('skill_used', { via: 'slash' })
      },
      [selectSkillFromPopup, trackEvent],
    )

    return (
      <>
        <div className="flex w-full flex-col gap-3">
          <ChatSkillsBar onAddToChat={handleAddChipFromBar} onAddInstruction={insertInstructionText} />
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
            renderOverlay={(value) => renderHighlightedSkillTokens(value, isValidSkillSlug)}
            popoverSlot={
              popupOpen ? (
                <SlashPopup
                  skills={popupSkills}
                  highlightedIdx={highlightedIdx}
                  onSelect={handleSelectFromSlashPopup}
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
