import { Button } from '@/components/ui/button'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type CopyMessageButtonProps = {
  text: string
  className?: string
}

/**
 * A button that copies the given text to the clipboard.
 * Shows a checkmark icon for 2 seconds after a successful copy.
 */
export const CopyMessageButton = ({ text, className }: CopyMessageButtonProps) => {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setIsCopied(true)
    timeoutRef.current = setTimeout(() => setIsCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`size-8 rounded-lg ${className ?? ''}`}
      title="Copy message"
      onClick={handleCopy}
    >
      {isCopied ? (
        <Check className="size-4 animate-[fadeOut_2s_ease-in-out]" />
      ) : (
        <Copy className="size-4" />
      )}
    </Button>
  )
}
