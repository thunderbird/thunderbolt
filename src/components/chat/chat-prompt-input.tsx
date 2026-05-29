/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isAgentAvailable as isAgentAvailable_default } from '@/acp/agent-availability'
import { useCurrentChatSession } from '@/chats/chat-store'
import { estimateTokensForText } from '@/ai/tokenizers'
import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { useIsMobile as useIsMobile_default } from '@/hooks/use-mobile'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { appendSlashToken } from '@/skills/compose-chat-input'
import { renderHighlightedSkillTokens, type SkillStatusClassifier } from '@/skills/highlight-skill-tokens'
import { resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { SlashPopup } from '@/skills/slash-popup'
import { useSlashCommand } from '@/skills/use-slash-command'
import {
  useEnabledSkills as useEnabledSkills_default,
  useLibrarySkills as useLibrarySkills_default,
} from '@/skills/use-skills'
import { type Model } from '@/types'
import { useChat as useChat_default } from '@ai-sdk/react'
import { useDraftInput } from '@/hooks/use-draft-input'
import { AlertCircle, Loader2 } from 'lucide-react'
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useLocation as useLocation_default, useNavigate as useNavigate_default } from 'react-router'
import { ChatSkillsBar } from './chat-skills-bar'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { PromptInput } from '../ui/prompt-input'
import { ChatModePicker } from './chat-mode-picker'
import { ChatModelPicker } from './chat-model-picker'

/**
 * Extract a human-readable display string from a connection error.
 * Handles JSON-RPC error messages (which have nested data.message),
 * plain strings, and generic Error objects.
 */
const extractErrorDisplay = (error: Error | null | undefined): string => {
  if (!error?.message) {
    return 'Connection failed'
  }

  try {
    const parsed = JSON.parse(error.message)
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
  useLocation?: typeof useLocation_default
  useChat?: typeof useChat_default
  useContextTracking?: typeof useContextTracking_default
  trackEvent?: typeof trackEvent_default
  useIsMobile?: typeof useIsMobile_default
  useLibrarySkills?: typeof useLibrarySkills_default
  useEnabledSkills?: typeof useEnabledSkills_default
  /** Inject for tests that need to drive the unavailable-agent fallback. */
  isAgentAvailable?: typeof isAgentAvailable_default
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
      isAgentAvailable = isAgentAvailable_default,
    },
    ref,
  ) => {
    const navigate = useNavigate()
    const location = useLocation()

    const { isMobile } = useIsMobile()

    const {
      chatInstance,
      chatThread,
      connectionStatus,
      connectionError,
      id: chatThreadId,
      selectedAgent,
      selectedModel,
    } = useCurrentChatSession()

    const { messages, status, stop, sendMessage } = useChat({ chat: chatInstance })

    const { skills: library } = useLibrarySkills()
    const { isEnabled } = useEnabledSkills()
    const skillBySlug = useMemo(() => new Map(library.map((s) => [s.name, s])), [library])
    const enabledSlugs = useMemo(
      () => new Set(library.filter((s) => isEnabled(s.id)).map((s) => s.name)),
      [library, isEnabled],
    )
    const isValidSkillSlug = useCallback((slug: string) => enabledSlugs.has(slug), [enabledSlugs])
    const classifySkill = useCallback<SkillStatusClassifier>(
      (slug) => {
        const skill = skillBySlug.get(slug)
        if (!skill) {
          return { status: 'unknown' }
        }
        return isEnabled(skill.id)
          ? { status: 'enabled', skillId: skill.id }
          : { status: 'disabled', skillId: skill.id }
      },
      [skillBySlug, isEnabled],
    )

    const isStreaming = status === 'streaming'
    const isConnecting = connectionStatus === 'connecting'
    const isConnectionError = connectionStatus === 'error' && connectionError != null

    // isMobile = viewport is narrow (responsive breakpoint, e.g. desktop browser resized small)
    // isPlatformMobile() = native platform is iOS/Android (Tauri mobile app)
    // Either condition means we prefer mobile-style input where Enter inserts a newline.
    const shouldInsertNewlineOnEnter = isMobile || isPlatformMobile()

    // Use a stable "new" key for unsaved chats so the draft persists across /chats/new navigations
    const draftKey = chatThread ? chatThreadId : 'new'
    const [showOverflowModal, setShowOverflowModal] = useState(false)
    const isNewChat = !chatThread
    const [input, setInput, clearDraft] = useDraftInput(draftKey, { persist: !isNewChat })
    // Latest-input ref so deferred callers (e.g. the `runSkill` microtask
    // below) read the current value at execution time rather than the value
    // captured when the callback was created. Without this, a draft restore
    // racing with the microtask could silently discard the user's text.
    const inputRef = useRef(input)
    inputRef.current = input
    const formRef = useRef<HTMLFormElement>(null)
    // Discovered lazily — the form ref is set after the first render, and we
    // need a stable ref to pass to `useSlashCommand` so it can focus / set
    // selection after inserting a token. Keeping a single ref (rather than
    // one for the form and one for the textarea) avoids two cached pointers
    // to the same node drifting out of sync.
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)

    const getTextarea = (): HTMLTextAreaElement | null => {
      textareaRef.current = formRef.current?.querySelector('textarea') ?? null
      return textareaRef.current
    }

    textareaRef.current = getTextarea()

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
      inputRef: textareaRef,
      library,
      isEnabled: isValidSkillSlug,
    })

    const addSkillChip = useCallback(
      (slug: string) => {
        // Read the latest input from a ref so deferred callers (e.g. the
        // `runSkill` microtask) don't operate on a stale closure value.
        const next = appendSlashToken(inputRef.current, slug)
        // Update value AND cursor in the same commit. Otherwise the re-render
        // between `setInput` and the rAF runs with a stale `cursorPos` that
        // may still point inside a `/slug` token, briefly flashing the slash
        // popup open — same fix as `selectSkill` in `use-slash-command.ts`.
        setInput(next)
        setCursorPos(next.length)
        requestAnimationFrame(() => {
          const ta = getTextarea()
          ta?.focus()
          ta?.setSelectionRange(next.length, next.length)
        })
      },
      [setInput, setCursorPos],
    )

    const insertInstructionText = useCallback(
      (text: string) => {
        const ta = getTextarea()
        const start = ta?.selectionStart ?? input.length
        const end = ta?.selectionEnd ?? input.length
        const needsSpace = start > 0 && input[start - 1] !== ' '
        const insert = needsSpace ? ` ${text}` : text
        const next = input.slice(0, start) + insert + input.slice(end)
        const pos = start + insert.length
        // Update value AND cursor in the same commit. Otherwise the re-render
        // between `setInput` and the rAF runs with a stale `cursorPos` that
        // may still point inside a `/slug` token, briefly flashing the slash
        // popup open — same fix as `addSkillChip` above and `selectSkill`
        // in `use-slash-command.ts`.
        setInput(next)
        setCursorPos(pos)
        requestAnimationFrame(() => {
          const focused = getTextarea()
          focused?.focus()
          focused?.setSelectionRange(pos, pos)
        })
      },
      [input, setInput, setCursorPos],
    )

    // Run-in-chat router-state nav (Skills v1 §5). Read once during render
    // and clear the state via `navigate(replace)` so back/forward doesn't
    // re-trigger. Tracked via `consumedRunSkillRef` so React's StrictMode
    // double-render doesn't insert the token twice. Once the state is
    // cleared we reset the ref so the user can click "Run skill" on the
    // same skill again.
    const consumedRunSkillRef = useRef<string | null>(null)
    const runSkill = (location.state as { runSkill?: string } | null)?.runSkill
    if (!runSkill) {
      consumedRunSkillRef.current = null
    } else if (consumedRunSkillRef.current !== runSkill) {
      consumedRunSkillRef.current = runSkill
      // Defer setState until after render to avoid setState-in-render warnings.
      queueMicrotask(() => {
        addSkillChip(runSkill)
        navigate(location.pathname, { replace: true, state: {} })
        trackEvent('skill_used', { via: 'settings-nav' })
      })
    }

    // Map of enabled-skill slug → instruction. Shared by the overflow
    // estimate below and the send-time resolver in `ai/fetch.ts` (via
    // `resolveSkillTokenInstructions`), so a future change to resolution
    // semantics moves both surfaces together.
    const enabledInstructionBySlug = useMemo(() => {
      const map = new Map<string, string>()
      for (const skill of library) {
        if (isEnabled(skill.id)) {
          map.set(skill.name, skill.instruction)
        }
      }
      return map
    }, [library, isEnabled])

    // Estimate the token cost of resolved skill instructions so the
    // overflow modal fires correctly when /name tokens push the send past
    // the model's context window — Skills v1 Open Q #5.
    const additionalInputTokens = useMemo(() => {
      const instructions = resolveSkillTokenInstructions(input, enabledInstructionBySlug)
      let total = 0
      for (const instruction of instructions) {
        total += estimateTokensForText(instruction)
      }
      return total
    }, [input, enabledInstructionBySlug])

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
        {isConnecting ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 px-3 h-[var(--touch-height-sm)] text-muted-foreground text-[length:var(--font-size-body)]"
          >
            <Loader2 className="size-[var(--icon-size-default)] shrink-0 animate-spin" />
            <span>Connecting to {selectedAgent.name}...</span>
          </div>
        ) : isConnectionError ? (
          <div
            role="alert"
            className="flex items-center gap-2 px-3 h-[var(--touch-height-sm)] text-destructive text-[length:var(--font-size-body)]"
          >
            <AlertCircle className="size-[var(--icon-size-default)] shrink-0" />
            <span className="truncate" title={extractErrorDisplay(connectionError)}>
              Failed to connect to {selectedAgent.name}
            </span>
          </div>
        ) : (
          <>
            <ChatModePicker iconOnly={isMobile} />
            <ChatModelPicker />
          </>
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

    if (!isAgentAvailable(selectedAgent)) {
      return (
        <div
          role="status"
          className="flex items-center justify-center px-4 py-3 text-muted-foreground text-[length:var(--font-size-sm)]"
        >
          <span>This chat uses {selectedAgent.name}, which is not available on this platform.</span>
        </div>
      )
    }

    return (
      <>
        <div className="flex w-full flex-col gap-3">
          <ChatSkillsBar
            onAddToChat={handleAddChipFromBar}
            onAddInstruction={insertInstructionText}
            // Pinning is a "starting a new chat" affordance — once the thread
            // has any message, hide the bar so chips don't compete for space.
            hidden={messages.length > 0}
          />
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
            className="flex flex-col w-full gap-0 rounded-2xl border bg-card p-2 dark:border-input dark:bg-[oklch(0.182_0_0)]"
            footerStartElements={footerStartElements}
            renderOverlay={(value) => renderHighlightedSkillTokens(value, classifySkill)}
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
