import { AutosizeTextarea } from '@/components/ui/autosize-textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Model } from '@/types'
import { ArrowUp, Lock, Square } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  models: Model[]
  selectedModelId?: string
  onModelChange: (model: string | null) => void
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
}

/**
 * Reusable prompt input component with AutosizeTextarea and model selection
 * Used in both chat interface and automation modals with multi-line support
 */
export const PromptInput = forwardRef<HTMLFormElement, PromptInputProps>(
  (
    {
      value = '',
      onChange,
      placeholder = 'Say something...',
      models,
      selectedModelId,
      onModelChange,
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
    },
    ref,
  ) => {
    const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      // Prevent submission while streaming
      if (!isStreaming) {
        onSubmit?.()
      }
    }

    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isStreaming && submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onSubmit?.()
      }
    }

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
          className="w-full border-none bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 resize-none"
        />

        <div className="flex gap-2 justify-between items-center w-full">
          <div className="flex items-center gap-2">{footerStartElements}</div>

          <div className="flex gap-2 items-center">
            <Select value={selectedModelId} onValueChange={onModelChange}>
              <SelectTrigger className="rounded-full" size="sm">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    <div className="flex items-center gap-2">
                      {model.isConfidential ? <Lock className="size-3.5" /> : null}
                      <p className="text-left">{model.name}</p>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {showSubmitButton &&
              (isStreaming ? (
                <Button
                  type="button"
                  variant="default"
                  className="h-6 w-6 rounded-full flex items-center justify-center"
                  onClick={onStop}
                >
                  <Square className="size-3" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="default"
                  className="h-6 w-6 rounded-full flex items-center justify-center"
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
