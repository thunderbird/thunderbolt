/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { type ReactNode } from 'react'

export type DataOption = 'keep' | 'delete'

export type SelectableCardProps = {
  selected: boolean
  onSelect: () => void
  icon: ReactNode
  title: string
  description: string
  variant?: 'default' | 'destructive'
}

export const SelectableCard = ({
  selected,
  onSelect,
  icon,
  title,
  description,
  variant = 'default',
}: SelectableCardProps) => {
  const isDestructive = variant === 'destructive'

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative flex w-full items-center gap-4 rounded-xl border bg-card p-4 text-left transition-all cursor-pointer',
        'hover:border-muted-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && !isDestructive && 'border-primary/50 bg-primary/5 shadow-sm shadow-primary/10',
        selected && isDestructive && 'border-destructive/50 bg-destructive/5 shadow-sm shadow-destructive/10',
        !selected && 'border-border hover:bg-accent/30',
      )}
    >
      {/* Radio indicator */}
      <div
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
          selected && !isDestructive && 'border-primary bg-primary',
          selected && isDestructive && 'border-destructive bg-destructive',
          !selected && 'border-muted-foreground/40 group-hover:border-muted-foreground/60',
        )}
      >
        {selected && <div className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
      </div>

      {/* Icon */}
      <div
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors',
          selected && isDestructive && 'bg-destructive/15 text-destructive',
          selected && !isDestructive && 'bg-primary/15 text-primary',
          !selected && 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            'font-medium transition-colors',
            selected && isDestructive && 'text-destructive',
            selected && !isDestructive && 'text-primary',
          )}
        >
          {title}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">{description}</p>
      </div>
    </button>
  )
}
