import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type SelectorTriggerProps = {
  icon: ReactNode
  label: string
  isOpen: boolean
  maxLength?: number
}

export const SelectorTrigger = ({ icon, label, isOpen, maxLength = 24 }: SelectorTriggerProps) => {
  const displayLabel = label.length > maxLength ? `${label.slice(0, maxLength)}…` : label

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 h-[var(--touch-height-sm)] rounded-lg cursor-pointer transition-colors text-[length:var(--font-size-body)] text-muted-foreground',
        isOpen ? 'bg-accent' : 'hover:bg-accent/50',
      )}
    >
      {icon}
      <span className="font-medium">{displayLabel}</span>
    </div>
  )
}
