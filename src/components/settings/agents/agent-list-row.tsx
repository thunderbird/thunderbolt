/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { IconTile } from '@/components/settings/icon-tile'
import { SettingsSelectableRow } from '@/components/settings/settings-list'

/** The square icon box that leads every agent list row and detail header. */
export const AgentIconTile = ({ children }: { children: ReactNode }) => <IconTile>{children}</IconTile>

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
  <div data-testid={testId}>
    <SettingsSelectableRow
      title={title}
      subtitle={<span data-testid={subtitleTestId}>{subtitle}</span>}
      leading={<AgentIconTile>{icon}</AgentIconTile>}
      isSelected={isSelected}
      isDimmed={isDimmed}
      onSelect={onOpen}
      ariaLabel={ariaLabel}
      trailingIcon={
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
          data-testid={chevronTestId}
        />
      }
    />
  </div>
)
