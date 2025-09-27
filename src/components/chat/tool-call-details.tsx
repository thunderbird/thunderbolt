import { createRef, forwardRef, useImperativeHandle, useState } from 'react'
import { AlertDialog, AlertDialogOverlay } from '@/components/ui/alert-dialog'
import type { ToolUIPart } from 'ai'
import { splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'
import { Button } from '../ui/button'
import { X } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'

export type ToolCallDetailsRef = {
  open: (toolCall: ToolUIPart) => void
  close: () => void
}

const getOutput = (part: any) => {
  if (typeof part?.output === 'string') {
    return part?.output
  } else {
    return JSON.stringify(part?.output, null, 2)
  }
}

export const toolCallDetailsRef = createRef<ToolCallDetailsRef>()

export const ToolCallDetails = forwardRef<ToolCallDetailsRef>((_, ref) => {
  const [open, setOpen] = useState(false)
  const [toolCall, setToolCall] = useState<ToolUIPart | null>()

  const [, toolName] = splitPartType(toolCall?.type ?? '')
  const metadata = getToolMetadataSync(toolName, toolCall?.input)

  const isMobile = useIsMobile()

  const onOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
  }

  useImperativeHandle(ref, () => ({
    open: (selectedToolCall) => {
      onOpenChange(true)
      setToolCall(selectedToolCall)
    },
    close: () => onOpenChange(false),
  }))

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogOverlay>
        <ResizablePanelGroup direction="horizontal" className="w-full">
          <ResizablePanel onClick={() => onOpenChange(false)} />
          <ResizableHandle />
          <ResizablePanel defaultSize={isMobile ? 90 : 30}>
            <div className="flex flex-1 h-full bg-card flex-col">
              <div className="flex flex-row justify-between items-center p-6 gap-6">
                <p className="text-lg leading-none font-semibold">{metadata.displayName}</p>
                <Button onClick={() => onOpenChange(false)} variant="ghost">
                  <X />
                </Button>
              </div>
              <div className="whitespace-pre-wrap bg-accent p-6 flex flex-1 overflow-scroll">{getOutput(toolCall)}</div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </AlertDialogOverlay>
    </AlertDialog>
  )
})

ToolCallDetails.displayName = 'ToolCallDetails'
