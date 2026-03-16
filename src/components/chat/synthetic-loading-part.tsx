import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Expandable } from '../ui/expandable'

type SyntheticLoadingPartProps = {
  message?: string
  messages?: string[]
  isStreaming?: boolean
}

export const SyntheticLoadingPart = ({ message = '', messages, isStreaming }: SyntheticLoadingPartProps) => {
  const [messageIndex, setMessageIndex] = useState(0)
  const rotatingMessages = messages ?? (message ? null : null)

  useEffect(() => {
    if (!rotatingMessages || !isStreaming) return

    const interval = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % rotatingMessages.length)
    }, 5000)

    return () => clearInterval(interval)
  }, [rotatingMessages, isStreaming])

  if (!isStreaming) {
    return null
  }

  const displayMessage = rotatingMessages
    ? rotatingMessages[messageIndex]
    : message && message.trim().length > 0
      ? message
      : '\u00A0'

  const titleNode = <span className="text-sm text-secondary-foreground">{displayMessage}</span>

  return (
    <Expandable
      title={titleNode}
      defaultOpen={false}
      icon={<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      className="shadow-none pointer-events-none mt-6" // Prevent clicking while loading
    >
      {null}
    </Expandable>
  )
}
