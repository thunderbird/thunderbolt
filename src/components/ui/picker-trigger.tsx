/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

type PickerTriggerProps = ComponentPropsWithoutRef<'span'> & {
  label: string
  icon?: ReactNode
  isOpen: boolean
  /** `pill` is the rounded standalone style used in modals; `composer` is the
   *  squared, borderless, hover-accent style of the chat composer's controls. */
  variant: 'pill' | 'composer'
}

/**
 * The closed state of a picker: a muted label with a chevron, and an optional leading icon.
 * A `span`, so it can sit inside a `<button>`.
 */
export const PickerTrigger = ({ label, icon, isOpen, variant, className, ...props }: PickerTriggerProps) => (
  <span
    className={cn(
      'flex min-w-0 items-center cursor-pointer transition-colors',
      variant === 'composer'
        ? cn(
            'gap-1.5 px-2 h-[var(--touch-height-control)] rounded-[var(--radius-control)] text-[length:var(--font-size-sm)]',
            isOpen ? 'bg-accent' : 'hover:bg-accent/50',
          )
        : cn(
            'gap-2 px-3 h-[var(--touch-height-sm)] rounded-full text-[length:var(--font-size-body)]',
            isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
          ),
      className,
    )}
    {...props}
  >
    {icon}
    {/* Muted in both variants — trigger labels are chrome, not content.
        Truncates instead of wrapping when the composer gets narrow. */}
    <span className="min-w-0 truncate font-medium text-muted-foreground">{label}</span>
    <ChevronDown
      className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')}
    />
  </span>
)
