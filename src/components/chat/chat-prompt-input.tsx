/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isAgentAvailable as isAgentAvailable_default } from '@/acp/agent-availability'
import { useCurrentChatSession } from '@/chats/chat-store'
import { usePendingQuotes, usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { estimateTokensForText } from '@/ai/tokenizers'
import { useContextTracking as useContextTracking_default } from '@/hooks/use-context-tracking'
import { useIsMobile as useIsMobile_default } from '@/hooks/use-mobile'
import { isMobile as isPlatformMobile } from '@/lib/platform'
import { trackEvent as trackEvent_default } from '@/lib/posthog'
import { appendSlashToken } from '@/skills/compose-chat-input'
import { buildDisplayNameToSlug, tokenForSkill } from '@/skills/display'
import { renderHighlightedSkillTokens, type SkillStatusClassifier } from '@/skills/highlight-skill-tokens'
import { deleteSkillTokenAt, normalizeSkillTokensToSlugs } from '@/skills/parse-skill-tokens'
import { resolveSkillTokenInstructions } from '@/skills/resolve-skill-system-messages'
import { SlashPopup } from '@/skills/slash-popup'
import { useSkillTelemetry } from '@/skills/telemetry'
import { useSlashCommand } from '@/skills/use-slash-command'
import { useAgentCommands } from '@/acp/agent-commands-store'
import { useWarmAcpCommands } from '@/chats/use-warm-acp-commands'
import {
  useEnabledSkills as useEnabledSkills_default,
  useLibrarySkills as useLibrarySkills_default,
} from '@/skills/use-skills'
import { type AttachmentData, type Model } from '@/types'
import { useChat as useChat_default } from '@ai-sdk/react'
import { messageBookkeepingThrottleMs } from '@/chats/chat-throttle'
import { useDraftInput } from '@/hooks/use-draft-input'
import { AnimatePresence, m } from 'framer-motion'
import { AlertCircle, Loader2, Paperclip, Plus, X } from 'lucide-react'
import { type ClipboardEvent, forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useLocation as useLocation_default, useNavigate as useNavigate_default } from 'react-router'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ChatSkillsBar } from './chat-skills-bar'
import { ContextOverflowModal } from '../context-overflow-modal'
import { ContextUsageIndicator } from '../context-usage-indicator'
import { PromptInput } from '../ui/prompt-input'
import { ChatModePicker } from './chat-mode-picker'
import { ChatModelPicker } from './chat-model-picker'
import { buildAttachmentPart } from '@/lib/attachments'
import { buildQuotePart } from '@/lib/quotes'
import { QuoteChip } from './quote-chip'
import { deleteAttachment, putAttachment } from '@/lib/file-blob-storage'
import { FileCard } from './file-card'

/** Max size for a chat attachment stored locally and sent to the agent. */
const maxAttachmentBytes = 25 * 1024 * 1024
const maxAttachmentCount = 10

/** Mime types accepted as attachments. PDFs and images deliver natively to
 *  capable models; plain-text types (txt / md / csv / json) deliver as text;
 *  docx (and a native file a model rejects) auto-remediate to text/images. */
const acceptedAttachmentMimeTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
  'text/csv',
  'application/json',
])

/** Extension fallback for when the browser reports an empty/odd mime type
 *  (common for .md). */
const acceptedAttachmentExtensions = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.docx',
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
]

/** `accept` attribute string for the file picker. */
const attachmentAcceptAttr = [...acceptedAttachmentMimeTypes, ...acceptedAttachmentExtensions].join(',')

const isAcceptedAttachment = (file: File): boolean =>
  acceptedAttachmentMimeTypes.has(file.type) ||
  acceptedAttachmentExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))

/** Clipboard files (e.g. a pasted screenshot) often arrive with an empty name.
 *  Give them a stable, extension-bearing filename so the chip renders and the
 *  extension-based accept check has something to work with. */
const withClipboardFilename = (file: File, index: number): File => {
  if (file.name) {
    return file
  }
  const ext = file.type.split('/')[1] ?? 'png'
  return new File([file], `pasted-image-${Date.now()}-${index}.${ext}`, { type: file.type })
}

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

    const { messages, status, stop, sendMessage } = useChat({
      chat: chatInstance,
      experimental_throttle: messageBookkeepingThrottleMs,
    })

    const { skills: library } = useLibrarySkills()
    const { isEnabled } = useEnabledSkills()
    const trackSkillEvent = useSkillTelemetry()
    const skillBySlug = useMemo(() => new Map(library.map((s) => [s.name, s])), [library])
    // Display-title → slug, for the whole library (disabled skills still
    // highlight as amber chips). The composer shows `/Daily Brief`; the model
    // and stored message get `/daily-brief` via send-time normalization.
    const displayNameToSlug = useMemo(() => buildDisplayNameToSlug(library), [library])
    const enabledSlugs = useMemo(
      () => new Set(library.filter((s) => isEnabled(s.id)).map((s) => s.name)),
      [library, isEnabled],
    )
    const isValidSkillSlug = useCallback((slug: string) => enabledSlugs.has(slug), [enabledSlugs])

    // Commands the connected ACP agent advertises — surfaced in the slash menu
    // as external suggestions alongside the user's own skills, and treated as
    // valid slugs by the highlighter so they don't render red.
    const agentCommands = useAgentCommands(selectedAgent.id)
    const agentCommandNames = useMemo(() => new Set(agentCommands.map((c) => c.name)), [agentCommands])

    const classifySkill = useCallback<SkillStatusClassifier>(
      (slug) => {
        const skill = skillBySlug.get(slug)
        if (skill) {
          return isEnabled(skill.id)
            ? { status: 'enabled', skillId: skill.id }
            : { status: 'disabled', skillId: skill.id }
        }
        // No user skill by that name — but an external command advertised by the
        // connected agent is still a valid slug, so treat it as enabled rather
        // than flagging it unknown (red, with a "Create it" popover).
        if (agentCommandNames.has(slug)) {
          return { status: 'enabled' }
        }
        return { status: 'unknown' }
      },
      [skillBySlug, isEnabled, agentCommandNames],
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
    const [attachments, setAttachments] = useState<AttachmentData[]>([])
    const [attachError, setAttachError] = useState<string | null>(null)
    // Quote-reply passages pulled in from the "Reply" button on a response. Held
    // in a per-thread store (not local state) so that button — which lives deep
    // in the message list — can add to the composer without prop-drilling.
    const quotes = usePendingQuotes(chatThreadId)
    const removeQuote = usePendingQuotesStore((s) => s.removeQuote)
    const setQuotes = usePendingQuotesStore((s) => s.setQuotes)
    const clearQuotes = usePendingQuotesStore((s) => s.clearQuotes)
    const [isDragging, setIsDragging] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)
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

    // Eagerly connect the agent + warm its ACP session so the agent commands
    // are populated before the user's first message (not just after a send).
    useWarmAcpCommands({ id: chatThreadId, selectedAgent, chatThread })

    const {
      setCursorPos,
      popupItems,
      popupOpen,
      highlightedIdx,
      setHighlightedIdx,
      selectItem: selectItemFromPopup,
      handleKeyDown: handleSlashKeyDown,
    } = useSlashCommand({
      value: input,
      setValue: setInput,
      inputRef: textareaRef,
      library,
      isEnabled: isValidSkillSlug,
      agentCommands,
    })

    const addSkillChip = useCallback(
      (slug: string) => {
        // Read the latest input from a ref so deferred callers (e.g. the
        // `runSkill` microtask) don't operate on a stale closure value.
        // Insert the display title, not the slug — the user only ever sees
        // titles in chat; send-time normalization restores the slug.
        // `tokenForSkill` falls back to the slug for ambiguous display names
        // so the token stays resolvable at send time.
        const skill = skillBySlug.get(slug)
        const next = appendSlashToken(inputRef.current, skill ? tokenForSkill(skill, displayNameToSlug) : slug)
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
      [setInput, setCursorPos, skillBySlug, displayNameToSlug],
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

    // Run-in-chat router-state nav (Skills v1 §5). Same consume-once shape as
    // `useConsumeNavState` (which skills-view uses) — kept inline here only
    // because this component's router hooks are injectable for tests. Read
    // once during render and clear the state via `navigate(replace)` so
    // back/forward doesn't re-trigger; the ref guard keeps StrictMode's
    // double-render from inserting the token twice.
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
        const resolved = skillBySlug.get(runSkill)
        if (resolved) {
          trackSkillEvent('skill_used', resolved.id, { via: 'settings-nav' })
        }
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

    // Estimate the token cost of resolved skill instructions and pending
    // quote passages so the overflow modal fires correctly when /name tokens
    // or large quoted selections push the send past the model's context window
    // — Skills v1 Open Q #5. Quotes are injected into the send (as `> …`
    // blockquotes) but aren't part of `currentInput`, so they'd otherwise be
    // invisible to the estimate.
    // Display tokens (`/Daily Brief`) become slugs (`/daily-brief`) here — the
    // model, the stored message, and the token estimate only ever see slugs.
    // One memo feeds both the estimate and the send so they agree by
    // construction.
    const normalizedInput = useMemo(
      () => normalizeSkillTokensToSlugs(input, displayNameToSlug),
      [input, displayNameToSlug],
    )

    const additionalInputTokens = useMemo(() => {
      // The resolver (shared with the send path in ai/fetch.ts) only speaks slugs.
      const instructions = resolveSkillTokenInstructions(normalizedInput, enabledInstructionBySlug)
      let total = 0
      for (const instruction of instructions) {
        total += estimateTokensForText(instruction)
      }
      for (const quote of quotes) {
        total += estimateTokensForText(quote.data.text)
      }
      return total
    }, [normalizedInput, enabledInstructionBySlug, quotes])

    const { usedTokens, maxTokens, isContextKnown, isOverflowing } = useContextTracking({
      model: selectedModel,
      chatThreadId,
      currentInput: normalizedInput,
      additionalInputTokens,
      onOverflow: () => handleShowOverflowModal(selectedModel, normalizedInput.trim().length, messages.length + 1),
    })

    // Store dropped/picked PDFs locally (IndexedDB) and add reference-only
    // attachments. Bytes never enter a message part — only the localFileId ref.
    const addFiles = useCallback(
      async (files: File[]) => {
        setAttachError(null)
        // `count` tracks the running total as we add through the loop, since
        // `setAttachments` won't have flushed mid-iteration.
        let count = attachments.length
        for (const file of files) {
          if (count >= maxAttachmentCount) {
            setAttachError(`You can attach up to ${maxAttachmentCount} files.`)
            break
          }
          if (!isAcceptedAttachment(file)) {
            setAttachError(`"${file.name}" isn't a supported file type.`)
            continue
          }
          if (file.size > maxAttachmentBytes) {
            setAttachError(`"${file.name}" is too large (max ${maxAttachmentBytes / 1024 / 1024}MB).`)
            continue
          }
          const localFileId = crypto.randomUUID()
          try {
            await putAttachment({
              id: localFileId,
              filename: file.name,
              mimeType: file.type,
              size: file.size,
              createdAt: Date.now(),
              blob: file,
            })
          } catch (error) {
            // IndexedDB can reject when its storage quota is exceeded or it's
            // unavailable. Surface it instead of letting the `void`-called
            // promise reject silently — otherwise no chip appears and no banner
            // shows. Stop here: subsequent writes would hit the same failure.
            console.error('Failed to store attachment locally:', error)
            setAttachError(`Couldn't attach "${file.name}" — your browser's storage is full or unavailable.`)
            break
          }
          setAttachments((prev) => [...prev, { localFileId, filename: file.name, mimeType: file.type }])
          count++
        }
      },
      [attachments.length],
    )

    // Intercept clipboard paste (Cmd/Ctrl+V) so copied files and pasted images
    // become attachments — the same path as drag-drop and the paperclip. Only
    // preventDefault when the clipboard actually carries files, so a normal text
    // paste falls through untouched.
    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((file): file is File => file != null)
        if (files.length === 0) {
          return
        }
        e.preventDefault()
        void addFiles(files.map(withClipboardFilename))
      },
      [addFiles],
    )

    const removeAttachment = useCallback((localFileId: string) => {
      setAttachments((prev) => prev.filter((a) => a.localFileId !== localFileId))
      deleteAttachment(localFileId).catch((error) => console.error('Failed to delete local attachment:', error))
    }, [])

    const handleSubmit = async () => {
      try {
        // Prevent submitting while streaming, or with no text, attachments, or quotes.
        const textToSend = normalizedInput.trim()
        if (isStreaming || (!textToSend && attachments.length === 0 && quotes.length === 0)) {
          return
        }

        if (isOverflowing) {
          handleShowOverflowModal(selectedModel, textToSend.length, messages.length + 1)
          return
        }

        // Reference-only attachment parts — bytes stay in IndexedDB and are
        // hydrated per-agent at send time (see the file transports).
        const attachmentParts = attachments.map(buildAttachmentPart)
        // Quote parts render as blockquotes and hydrate to `> …` text for the model.
        const quoteParts = quotes.map((quote) => buildQuotePart(quote.data))

        // Clear input, draft, pending attachments, and quotes immediately for responsive UX
        clearDraft()
        setAttachments([])
        clearQuotes(chatThreadId)
        setAttachError(null)

        await sendMessage({
          parts: [
            ...quoteParts,
            ...(textToSend ? [{ type: 'text' as const, text: textToSend }] : []),
            ...attachmentParts,
          ],
        })
      } catch (error) {
        console.error('Error submitting message:', error)
        // Send failed — the chips were cleared optimistically but the blobs are
        // still in IndexedDB, so restore them rather than orphaning the bytes.
        setAttachments(attachments)
        setQuotes(
          chatThreadId,
          quotes.map((quote) => quote.data),
        )
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add to chat"
              title="Add to chat"
              // `hover:bg-accent/50` / open `bg-accent` match the mode and
              // model picker triggers sitting in the same footer row.
              className="flex size-[var(--touch-height-control)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <Plus className="size-[var(--icon-size-sm)]" />
            </button>
          </DropdownMenuTrigger>
          {/* Opens downward on desktop, matching the mode/model selectors. */}
          <DropdownMenuContent side={isMobile ? 'top' : 'bottom'} align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => fileInputRef.current?.click()} className="cursor-pointer">
              <Paperclip className="size-[var(--icon-size-sm)]" />
              Upload file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
        ) : null}
        {isContextKnown && !isMobile && (
          <ContextUsageIndicator usedTokens={usedTokens ?? 0} maxTokens={maxTokens ?? 0} />
        )}
      </div>
    )

    // Mode/model pickers sit in the footer's right cluster, next to the send
    // button; the connecting / connection-error status replaces them on the
    // left, so the right side only renders them in the healthy state.
    const footerEndElements =
      !isConnecting && !isConnectionError ? (
        <>
          <ChatModePicker iconOnly={isMobile} />
          <ChatModelPicker />
        </>
      ) : undefined

    const handleAddChipFromBar = useCallback(
      (slug: string) => {
        addSkillChip(slug)
        const resolved = skillBySlug.get(slug)
        if (resolved) {
          trackSkillEvent('skill_used', resolved.id, { via: 'chip' })
        }
      },
      [addSkillChip, skillBySlug, trackSkillEvent],
    )

    // Backspace treats a display-title chip (`/Daily Brief`) as atomic: one
    // press removes the whole token instead of eating it a letter at a time.
    const handleTextareaKeyDown = useCallback(
      (e: Parameters<typeof handleSlashKeyDown>[0]) => {
        const ta = e.currentTarget
        const caretCollapsed = ta.selectionStart === ta.selectionEnd
        if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey && caretCollapsed) {
          const deletion = deleteSkillTokenAt(inputRef.current, ta.selectionStart, displayNameToSlug)
          if (deletion) {
            e.preventDefault()
            setInput(deletion.text)
            setCursorPos(deletion.caret)
            requestAnimationFrame(() => {
              const el = getTextarea()
              el?.focus()
              el?.setSelectionRange(deletion.caret, deletion.caret)
            })
            return
          }
        }
        handleSlashKeyDown(e)
      },
      [displayNameToSlug, setInput, setCursorPos, handleSlashKeyDown],
    )

    const handleSelectFromSlashPopup = useCallback(
      (item: Parameters<typeof selectItemFromPopup>[0]) => {
        selectItemFromPopup(item)
        // Telemetry is for the user's own skills; agent commands are external.
        if (item.kind === 'skill') {
          trackSkillEvent('skill_used', item.skill.id, { via: 'slash' })
        }
      },
      [selectItemFromPopup, trackSkillEvent],
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
        <div
          className="relative flex w-full flex-col rounded-3xl"
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setIsDragging(false)
            void addFiles(Array.from(e.dataTransfer.files))
          }}
        >
          {isDragging && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-ring bg-muted/80 backdrop-blur-sm">
              <span className="text-[length:var(--font-size-sm)] font-medium text-muted-foreground">
                Drop file to attach
              </span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={attachmentAcceptAttr}
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          {/* Chips + error banner ride in an overlay anchored to the composer's TOP
              edge, so the composer is a fixed anchor: the overlay is out of flow
              (only `bottom` pinned → content-height, grows UPWARD), so the composer's
              box never reacts to the banner — it stays put in every state (empty,
              mid-chat, after a send). `pb-2` gives the chips their normal resting gap
              above the composer; when the banner grows in it pushes the chips up, and
              they slide back down on dismiss. pointer-events gated so the empty
              overlay area doesn't eat clicks behind it. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-full flex flex-col">
            {/* Chips keep their normal resting gap above the composer (pb-2). */}
            <div className="pointer-events-auto pb-2">
              <ChatSkillsBar
                onAddToChat={handleAddChipFromBar}
                onAddInstruction={insertInstructionText}
                // Pinning is a "starting a new chat" affordance — once the thread
                // has any message, hide the bar so chips don't compete for space.
                hidden={messages.length > 0}
              />
            </div>
            <AnimatePresence initial={false}>
              {attachError && (
                <m.div
                  key="attach-error"
                  // marginBottom pulls the banner's bottom -12px below the composer's
                  // top edge so it's hidden behind the composer's opaque z-10 body
                  // (the "emerges from behind" look). Animated in lockstep with height
                  // so dismiss collapses cleanly without over-pulling the chips.
                  initial={{ height: 0, opacity: 0, marginBottom: 0 }}
                  animate={{ height: 'auto', opacity: 1, marginBottom: -12 }}
                  exit={{ height: 0, opacity: 0, marginBottom: 0 }}
                  transition={{ type: 'tween', ease: [0.2, 0.9, 0.1, 1], duration: 0.25 }}
                  className="pointer-events-auto overflow-hidden"
                >
                  <div className="flex items-center gap-1.5 rounded-t-2xl bg-destructive/10 px-3 pb-4 pt-2 text-[length:var(--font-size-xs)] text-destructive">
                    <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{attachError}</span>
                    <button
                      type="button"
                      onClick={() => setAttachError(null)}
                      aria-label="Dismiss"
                      className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-destructive/15"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </div>
          <PromptInput
            ref={formRef}
            headerSlot={
              attachments.length > 0 || quotes.length > 0 ? (
                <div className="flex flex-col gap-2 pb-2">
                  {quotes.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      {quotes.map((quote) => (
                        <QuoteChip
                          key={quote.id}
                          text={quote.data.text}
                          onRemove={() => removeQuote(chatThreadId, quote.id)}
                        />
                      ))}
                    </div>
                  )}
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap items-start gap-2">
                      {attachments.map((attachment) => (
                        <FileCard
                          key={attachment.localFileId}
                          localFileId={attachment.localFileId}
                          filename={attachment.filename}
                          mimeType={attachment.mimeType}
                          onRemove={() => removeAttachment(attachment.localFileId)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ) : undefined
            }
            value={input}
            onChange={(value: string) => setInput(value)}
            placeholder="Ask me anything..."
            showSubmitButton
            onSubmit={handleSubmit}
            // Allow sending an attachment even with no typed text (matches the Enter behavior).
            canSubmit={input.trim().length > 0 || attachments.length > 0 || quotes.length > 0}
            isLoading={isStreaming || isConnecting}
            isStreaming={isStreaming}
            onStop={stop}
            autoFocus={!isMobile}
            submitOnEnter={!isStreaming && !shouldInsertNewlineOnEnter}
            className="relative z-10 flex flex-col w-full gap-0 rounded-3xl border border-transparent focus-within:border-border bg-sidebar p-2 shadow-glow dark:shadow-none transition-colors"
            footerStartElements={footerStartElements}
            footerEndElements={footerEndElements}
            renderOverlay={(value) => renderHighlightedSkillTokens(value, classifySkill, displayNameToSlug)}
            popoverSlot={
              popupOpen ? (
                <SlashPopup
                  items={popupItems}
                  agentName={selectedAgent.name}
                  highlightedIdx={highlightedIdx}
                  onSelect={handleSelectFromSlashPopup}
                  onHover={setHighlightedIdx}
                />
              ) : null
            }
            onTextareaKeyDown={handleTextareaKeyDown}
            onTextareaSelect={(e) => setCursorPos(e.currentTarget.selectionStart)}
            onTextareaPaste={handlePaste}
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
