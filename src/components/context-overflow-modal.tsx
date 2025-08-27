import { formatNumber } from '@/lib/utils'
import { AlertTriangle } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog'

interface ContextOverflowModalProps {
  isOpen: boolean
  onClose: () => void
  onNewChat: () => void
  maxTokens?: number
}

/**
 * Modal shown when a message would exceed the model's context window
 */
export const ContextOverflowModal = ({ isOpen, onClose, onNewChat, maxTokens }: ContextOverflowModalProps) => {
  const formattedMaxTokens = maxTokens ? formatNumber(maxTokens) : 'unknown'

  return (
    <AlertDialog open={isOpen} onOpenChange={() => onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-600" />
            <AlertDialogTitle>Context Window Exceeded</AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            <p>Your message would exceed the model's {formattedMaxTokens}-token context window.</p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Close</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onNewChat()
              onClose()
            }}
          >
            New Chat
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
