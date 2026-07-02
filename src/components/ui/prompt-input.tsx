/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AutosizeTextarea } from '@/components/ui/autosize-textarea'
import { Button } from '@/components/ui/button'
import { type ChatThread } from '@/layout/sidebar/types'
import { cn } from '@/lib/utils'
import type { Model } from '@/types'
import { ArrowUp, Square } from 'lucide-react'
import {
  type ChangeEvent,
  type FormEvent,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  type UIEvent,
  useRef,
} from 'react'
import { ModelSelector } from './model-selector'

type PromptInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  showSubmitButton?: boolean
  onSubmit?: () => void
  isLoading?: boolean
  autoFocus?: boolean
  className?: string
  submitOnEnter?: boolean
  noForm?: boolean
  isStreaming?: boolean
  onStop?: () => void
  footerStartElements?: ReactNode
  // Model selection props - optional, only used in automation modal
  chatThread?: ChatThread | null
  models?: Model[]
  selectedModel?: Model | null
  onModelChange?: (modelId: string) => void
  /**
   * When provided, the textarea's own text is rendered transparent and this
   * overlay is layered above to paint highlighted skill tokens. Scroll is
   * kept in sync between the textarea and the overlay.
   */
  renderOverlay?: (value: string) => ReactNode
  /**
   * Optional slot rendered inside the textarea wrapper, above the textarea.
   * Used for the slash-autocomplete popup so it positions relative to the
   * input.
   */
  popoverSlot?: ReactNode
  /** Receives every keydown so callers can intercept ↑↓/Enter/Esc for autocomplete. */
  onTextareaKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  /** Fires on selection change so callers can track the caret position. */
  onTextareaSelect?: (e: SyntheticEvent<HTMLTextAreaElement>) => void
  /** Fires on scroll so callers can sync overlays / popups. */
  onTextareaScroll?: (e: UIEvent<HTMLTextAreaElement>) => void
}

/**
 * Reusable prompt input component with AutosizeTextarea
 * Model selection is optional - only shown when models prop is provided
 */
export const PromptInput = forwardRef<HTMLFormElement, PromptInputProps>(
  (
    {
      value = '',
      onChange,
      placeholder = 'Say something...',
      showSubmitButton = true,
      onSubmit,
      isLoading = false,
      autoFocus = false,
      className = 'flex flex-col w-full gap-0 p-2',
      submitOnEnter = false,
      noForm = false,
      isStreaming = false,
      onStop,
      footerStartElements,
      chatThread = null,
      models,
      selectedModel,
      onModelChange,
      renderOverlay,
      popoverSlot,
      onTextareaKeyDown,
      onTextareaSelect,
      onTextareaScroll,
    },
    ref,
  ) => {
    const overlayRef = useRef<HTMLDivElement>(null)

    const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (!isStreaming) {
        onSubmit?.()
      }
    }

    const handleTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      onTextareaKeyDown?.(e)
      if (e.defaultPrevented) {
        return
      }
      if (!isStreaming && submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onSubmit?.()
      }
    }

    const handleScroll = (e: UIEvent<HTMLTextAreaElement>) => {
      if (overlayRef.current) {
        overlayRef.current.scrollTop = e.currentTarget.scrollTop
      }
      onTextareaScroll?.(e)
    }

    const hasTextareaHooks = Boolean(renderOverlay || onTextareaKeyDown || onTextareaSelect || onTextareaScroll)

    const showModelSelect = models && models.length > 0 && onModelChange

    const submitButton =
      showSubmitButton &&
      (isStreaming ? (
        <Button
          type="button"
          variant="default"
          className="size-[var(--touch-height-control)] rounded-lg flex items-center justify-center flex-shrink-0"
          onClick={onStop}
        >
          <Square className="size-[var(--icon-size-default)]" />
        </Button>
      ) : (
        <Button
          type="submit"
          variant="default"
          className="size-[var(--touch-height-control)] rounded-lg flex items-center justify-center flex-shrink-0"
          disabled={isLoading || !value.trim()}
        >
          <ArrowUp className="size-[var(--icon-size-default)]" />
        </Button>
      ))

    const content = (
      <>
        <div className="relative w-full">
          {popoverSlot}
          {renderOverlay && (
            <div
              ref={overlayRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10 overflow-hidden whitespace-pre-wrap break-words px-1 py-2 text-base leading-5 text-foreground"
            >
              {renderOverlay(value)}
            </div>
          )}
          <AutosizeTextarea
            value={value}
            onChange={handleTextareaChange}
            onKeyDown={submitOnEnter || hasTextareaHooks ? handleKeyDown : undefined}
            onSelect={onTextareaSelect}
            onScroll={hasTextareaHooks ? handleScroll : undefined}
            placeholder={placeholder}
            minHeight={42}
            maxHeight={240}
            autoFocus={autoFocus}
            className={cn(
              'w-full border-none bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 resize-none px-1 py-2 text-base leading-5',
              renderOverlay && 'text-transparent caret-foreground',
            )}
          />
        </div>

        <div className="flex justify-between items-end w-full">
          <div className="flex items-center gap-2">{footerStartElements}</div>

          <div className="flex gap-2 items-center">
            {showModelSelect && (
              <ModelSelector
                chatThread={chatThread}
                models={models}
                selectedModel={selectedModel ?? null}
                onModelChange={onModelChange}
                side="top"
                align="end"
              />
            )}

            {submitButton}
          </div>
        </div>
      </>
    )

    const formElement = noForm ? (
      <div className={className}>{content}</div>
    ) : (
      <form ref={ref} onSubmit={handleSubmit} className={className}>
        {content}
      </form>
    )

    return formElement
  },
)

PromptInput.displayName = 'PromptInput'
