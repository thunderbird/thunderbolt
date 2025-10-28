import { Lock } from 'lucide-react'
import TimelineMessage from './timeline-message'
import { memo } from 'react'

export const EncryptionMessage = memo(() => (
  <TimelineMessage>
    <div className="flex flex-row items-center gap-2">
      <Lock className="size-4 text-blue-600 dark:text-blue-400" />
      <p className="text-blue-700 dark:text-blue-300">This conversation is encrypted</p>
    </div>
  </TimelineMessage>
))
