import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'
import { ChevronDown, Lock } from 'lucide-react'
import { useState } from 'react'
import { ModelSelectorContent } from './model-selector-content'
import type { ModelSelectorProps } from './types'

export const ModelSelector = ({
  models,
  selectedModel,
  chatThread,
  onModelChange,
  onAddModels,
}: ModelSelectorProps) => {
  const [open, setOpen] = useState(false)
  const { isMobile } = useIsMobile()

  const handleSelect = (modelId: string) => {
    onModelChange(modelId)
    setOpen(false)
  }

  const triggerContent = (
    <div className="flex items-center gap-1.5 cursor-pointer">
      {selectedModel?.isConfidential === 1 && <Lock className="size-3.5 text-warning-500" />}
      <span className="font-medium">{selectedModel?.name ?? 'Select Model'}</span>
      <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
    </div>
  )

  const content = (
    <ModelSelectorContent
      models={models}
      selectedModel={selectedModel}
      chatThread={chatThread}
      onSelect={handleSelect}
      onAddModels={onAddModels}
    />
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button type="button" className="flex items-center">
            {triggerContent}
          </button>
        </SheetTrigger>
        <SheetContent side="top" className="p-0 rounded-b-xl" overlayClassName="backdrop-blur-sm bg-black/30">
          {content}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center">
          {triggerContent}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        {content}
      </PopoverContent>
    </Popover>
  )
}
