/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type ChoiceCardProps = {
  name: string
  value: string
  title: string
  description?: string
  icon: ReactNode
  checked: boolean
  disabled?: boolean
  compact?: boolean
  onSelect: () => void
}

/** A native, keyboard-accessible radio with a generous card-shaped hit target. */
export const ChoiceCard = ({
  name,
  value,
  title,
  description,
  icon,
  checked,
  disabled,
  compact,
  onSelect,
}: ChoiceCardProps) => {
  const id = useId()
  return (
    <label className={cn('relative min-w-0 cursor-pointer', disabled && 'cursor-not-allowed opacity-50')}>
      <input
        className="peer sr-only"
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
      />
      <span
        className={cn(
          'flex h-full gap-3 rounded-xl border border-border p-3 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
          checked ? 'border-foreground/40 bg-accent/60' : !disabled && 'hover:bg-accent/30',
          compact && 'flex-col gap-1.5 p-2.5',
        )}
      >
        <span className="flex shrink-0 items-center justify-between gap-2">
          <span aria-hidden="true" className={cn('text-muted-foreground [&>svg]:size-5', checked && 'text-foreground')}>
            {icon}
          </span>
          {compact && <RadioCircle checked={checked} />}
        </span>
        <span className="min-w-0 flex-1">
          <span id={`${id}-title`} className="block text-sm font-medium leading-snug">
            {title}
          </span>
          {description && (
            <span id={`${id}-description`} className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              {description}
            </span>
          )}
        </span>
        {!compact && <RadioCircle checked={checked} />}
      </span>
    </label>
  )
}

const RadioCircle = ({ checked }: { checked: boolean }) => (
  <span
    aria-hidden="true"
    className={cn(
      'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
      checked
        ? 'border-transparent bg-brand-muted bg-origin-border [background-image:var(--gradient-brand-muted)]'
        : 'border-muted-foreground/40',
    )}
  >
    {checked && <span className="size-1.5 rounded-full bg-white" />}
  </span>
)
