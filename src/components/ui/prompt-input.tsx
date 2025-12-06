import { AutosizeTextarea } from '@/components/ui/autosize-textarea'
import { Button } from '@/components/ui/button'
import { type ChatThread } from '@/layout/sidebar/types'
import type { Model } from '@/types'
import { ArrowUp, Square } from 'lucide-react'
import { forwardRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ModelSelect } from './model-select'

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
  selectedModelId?: string
  onModelChange?: (model: string | null) => void
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
      className = 'flex flex-col gap-2 bg-secondary p-4 rounded-md w-full max-w-[696px] min-w-[268px]',
      submitOnEnter = false,
      noForm = false,
      isStreaming = false,
      onStop,
      footerStartElements,
      chatThread = null,
      models,
      selectedModelId,
      onModelChange,
    },
    ref,
  ) => {
    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (!isStreaming) {
        onSubmit?.()
      }
    }

    const handleTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isStreaming && submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onSubmit?.()
      }
    }

    const showModelSelect = models && models.length > 0 && onModelChange

    const content = (
      <>
        <AutosizeTextarea
          value={value}
          onChange={handleTextareaChange}
          onKeyDown={submitOnEnter ? handleKeyDown : undefined}
          placeholder={placeholder}
          minHeight={52}
          maxHeight={240}
          autoFocus={autoFocus}
          className="w-full border-none bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 resize-none px-1 py-1"
        />

        <div className="flex gap-2 justify-between items-center w-full">
          <div className="flex items-center gap-2">{footerStartElements}</div>

          <div className="flex gap-2 items-center">
            {showModelSelect && (
              <ModelSelect
                chatThread={chatThread}
                models={models}
                selectedModelId={selectedModelId}
                onModelChange={onModelChange}
              />
            )}

            {showSubmitButton &&
              (isStreaming ? (
                <Button
                  type="button"
                  variant="default"
                  className="size-8 rounded-lg flex items-center justify-center"
                  onClick={onStop}
                >
                  <Square className="size-4" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="default"
                  className="size-8 rounded-lg flex items-center justify-center"
                  disabled={isLoading || !value.trim()}
                >
                  <ArrowUp className="size-4" />
                </Button>
              ))}
          </div>
        </div>
      </>
    )

    return noForm ? (
      <div className={className}>{content}</div>
    ) : (
      <form ref={ref} onSubmit={handleSubmit} className={className}>
        {content}
      </form>
    )
  },
)

PromptInput.displayName = 'PromptInput'
