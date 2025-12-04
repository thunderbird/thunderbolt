import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer transition-colors text-sm',
        open ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {selectedModel?.isConfidential === 1 && <Lock className="size-3.5 text-muted-foreground" />}
      <span className="font-medium">{selectedModel?.name ?? 'Select Model'}</span>
      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
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

  return (
    <Popover open={open} onOpenChange={setOpen} modal={isMobile}>
      <PopoverTrigger asChild>
        <button type="button" className={cn('flex items-center', isMobile && open && 'relative z-50')}>
          {triggerContent}
        </button>
      </PopoverTrigger>
      {/* Blur backdrop for mobile */}
      {isMobile && open && (
        <div className="fixed inset-0 z-40 backdrop-blur-sm bg-black/30" onClick={() => setOpen(false)} />
      )}
      <PopoverContent
        align={isMobile ? 'center' : 'start'}
        className={cn('p-0', isMobile ? 'w-[calc(100vw-2rem)]' : 'w-80')}
      >
        {content}
      </PopoverContent>
    </Popover>
  )
}
