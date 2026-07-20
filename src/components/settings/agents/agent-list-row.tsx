/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** The square icon box that leads every agent list row and detail header. */
export const AgentIconTile = ({ children }: { children: ReactNode }) => (
  <div className="flex aspect-square size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
    {children}
  </div>
)

type AgentListRowProps = {
  icon: ReactNode
  title: ReactNode
  subtitle: ReactNode
  /** Whether this row's detail panel is open — brightens the row like other
   *  selected list items across the app. */
  isSelected?: boolean
  /** Opens the detail panel. The whole row is the tap target; management
   *  lives in the detail. */
  onOpen: () => void
  ariaLabel: string
  /** Dims the primary line (e.g. a disabled agent). */
  isDimmed?: boolean
  testId?: string
  subtitleTestId?: string
  chevronTestId?: string
}

/**
 * The shared list-row anatomy for the agents page: icon tile + name on the
 * primary line, provenance on the secondary line, and a chevron. Backs both
 * `AgentRow` and the Thunderbolt CLI row so the two cannot drift.
 */
export const AgentListRow = ({
  icon,
  title,
  subtitle,
  isSelected,
  onOpen,
  ariaLabel,
  isDimmed = false,
  testId,
  subtitleTestId,
  chevronTestId,
}: AgentListRowProps) => (
  <Card data-testid={testId} className="border border-border p-0">
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaLabel}
      aria-pressed={isSelected}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-[inherit] px-4 py-3 text-left transition-colors',
        isSelected ? 'bg-accent' : 'hover:bg-secondary/50',
      )}
    >
      <AgentIconTile>{icon}</AgentIconTile>
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-base font-medium', isDimmed && 'text-muted-foreground')}>{title}</div>
        <div className="truncate text-[length:var(--font-size-sm)] text-muted-foreground" data-testid={subtitleTestId}>
          {subtitle}
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" data-testid={chevronTestId} />
    </button>
  </Card>
)
