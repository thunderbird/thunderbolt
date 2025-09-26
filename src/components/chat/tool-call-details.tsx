import { createRef, forwardRef, useImperativeHandle, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import type { ToolUIPart } from 'ai'
import { splitPartType } from '@/lib/utils'
import { getToolMetadataSync } from '@/lib/tool-metadata'
import { ScrollArea } from '../ui/scroll-area'

export type ToolCallDetailsRef = {
  open: (toolCall: ToolUIPart) => void
  close: () => void
}

type ToolCallDetailsProps = {
  //   onConfirm: () => void
}

const getOutput = (part: any) => {
  if (typeof part?.output === 'string') {
    return part?.output
  } else {
    return JSON.stringify(part?.output, null, 2)
  }
}

export const toolCallDetailsRef = createRef<ToolCallDetailsRef>()

export const ToolCallDetails = forwardRef<ToolCallDetailsRef, ToolCallDetailsProps>((_, ref) => {
  const [open, setOpen] = useState(false)
  const [toolCall, setToolCall] = useState<ToolUIPart | null>()

  const [, toolName] = splitPartType(toolCall?.type ?? '')
  const metadata = getToolMetadataSync(toolName, toolCall?.input)

  const onOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)

    if (!isOpen) {
      setToolCall(null)
    }
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
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{metadata.displayName}</AlertDialogTitle>
          <ScrollArea className="max-h-100 min-h-10">
            <AlertDialogDescription className="whitespace-pre-wrap">{getOutput(toolCall)}</AlertDialogDescription>
          </ScrollArea>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOpenChange(false)}>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
})

ToolCallDetails.displayName = 'ToolCallDetails'
