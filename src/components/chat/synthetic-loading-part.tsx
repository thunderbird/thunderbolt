import { Loader2 } from 'lucide-react'
import { Expandable } from '../ui/expandable'

interface SyntheticLoadingPartProps {
  message?: string
  isStreaming?: boolean
}

export const SyntheticLoadingPart = ({ message = '', isStreaming }: SyntheticLoadingPartProps) => {
  if (!isStreaming) {
    return null
  }

  const displayMessage = message && message.trim().length > 0 ? message : '\u00A0'

  const titleNode = <span className="text-sm text-secondary-foreground">{displayMessage}</span>

  return (
    <Expandable
      title={titleNode}
      defaultOpen={false}
      icon={<Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />}
      className="shadow-none pointer-events-none" // Prevent clicking while loading
    >
      {null}
    </Expandable>
  )
}
