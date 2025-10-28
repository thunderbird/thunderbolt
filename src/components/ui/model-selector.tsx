import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Model } from '@/types'
import { Lock } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { type ChatThread } from '@/layout/sidebar/types'
import { memo } from 'react'

interface ModelSelectorProps {
  chatThread: ChatThread | null
  models: Model[]
  selectedModelId?: string
  onModelChange: (model: string | null) => void
}

export const ModelSelector = memo(({ chatThread, models, selectedModelId, onModelChange }: ModelSelectorProps) => {
  return (
    <Select value={selectedModelId} onValueChange={onModelChange}>
      <SelectTrigger className="rounded-full" size="sm">
        <SelectValue placeholder="Select a model" />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => {
          const isDisabled = chatThread ? chatThread.isEncrypted !== model.isConfidential : false

          return (
            <Tooltip key={model.id}>
              <TooltipTrigger asChild>
                <SelectItem disabled={isDisabled} value={model.id} style={{ pointerEvents: 'auto' }}>
                  <div className="flex items-center gap-2">
                    {model.isConfidential ? <Lock className="size-3.5" /> : null}
                    <p className="text-left">{model.name}</p>
                  </div>
                </SelectItem>
              </TooltipTrigger>
              {chatThread && isDisabled && (
                <TooltipContent side="left">
                  <p>{`This model is not available for ${chatThread.isEncrypted === 1 ? 'encrypted' : 'unencrypted'} conversations.`}</p>
                </TooltipContent>
              )}
            </Tooltip>
          )
        })}
      </SelectContent>
    </Select>
  )
})
