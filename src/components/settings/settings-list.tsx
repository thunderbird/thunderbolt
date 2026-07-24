/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ComponentProps, ReactNode } from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** The scrollable list column of a settings page: centered, width-capped shell. */
export const SettingsListPane = ({ className, ...props }: ComponentProps<'section'>) => (
  <section
    className={cn(
      'mx-auto flex h-full w-full max-w-[760px] flex-col gap-3 bg-background p-4 text-foreground md:min-w-[360px] md:px-5',
      className,
    )}
    {...props}
  />
)

/** The scrolling region inside `SettingsListPane` (header stays pinned above it). */
export const SettingsListBody = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', className)} {...props} />
)

/** Uppercase section heading between groups of settings rows. */
export const SettingsSectionLabel = ({ className, ...props }: ComponentProps<'h2'>) => (
  <h2
    className={cn(
      'text-[length:var(--font-size-xs)] font-medium uppercase tracking-wide text-muted-foreground',
      className,
    )}
    {...props}
  />
)

type SettingsSelectableRowProps = Omit<ComponentProps<typeof Card>, 'onSelect' | 'title'> & {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  /** Interactive controls (e.g. a switch) in their own lane outside the row's tap target. */
  trailing?: ReactNode
  /** Decorative affordance (e.g. a chevron) rendered inside the tap target so clicking it selects the row. */
  trailingIcon?: ReactNode
  isSelected?: boolean
  isDimmed?: boolean
  onSelect: () => void
  ariaLabel: string
}

/** Shared settings row with a full-height trailing-control lane. */
export const SettingsSelectableRow = ({
  title,
  subtitle,
  leading,
  trailing,
  trailingIcon,
  isSelected = false,
  isDimmed = false,
  onSelect,
  ariaLabel,
  className,
  ...props
}: SettingsSelectableRowProps) => (
  <Card
    className={cn(
      'flex-row items-stretch gap-0 border-border p-0 transition-colors',
      isSelected ? 'bg-accent' : 'hover:bg-secondary/50',
      className,
    )}
    {...props}
  >
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={isSelected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-l-[inherit] px-4 py-3 text-left',
        !trailing && 'rounded-r-[inherit] pr-4',
      )}
    >
      {leading && <span className="flex shrink-0 items-center justify-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-base font-medium', isDimmed && 'text-muted-foreground')}>{title}</span>
        {subtitle && (
          <span className="block truncate text-[length:var(--font-size-sm)] text-muted-foreground">{subtitle}</span>
        )}
      </span>
      {trailingIcon && <span className="flex shrink-0 items-center">{trailingIcon}</span>}
    </button>
    {trailing && <div className="flex shrink-0 items-center rounded-r-[inherit] pr-4">{trailing}</div>}
  </Card>
)
