import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'
import { Check, Copy } from 'lucide-react'

type CopyMessageButtonProps = {
  text: string
  className?: string
}

/**
 * A button that copies the given text to the clipboard.
 * Shows a checkmark icon for 2 seconds after a successful copy.
 */
export const CopyMessageButton = ({ text, className }: CopyMessageButtonProps) => {
  const { copy, isCopied } = useCopyToClipboard()

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('size-8 rounded-lg', className)}
      title="Copy message"
      aria-label="Copy message"
      onClick={() => copy(text)}
    >
      {isCopied ? (
        <Check className="size-4 text-muted-foreground animate-[fadeOut_2s_ease-in-out]" />
      ) : (
        <Copy className="size-4 text-muted-foreground" />
      )}
    </Button>
  )
}
