/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ReactNode } from 'react'
import { Link } from 'react-router'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useWorkspaceUrl } from '@/lib/active-workspace'

/**
 * Hover-shows / hover-stays card anchored to a slash token in the chat
 * input overlay. We use Radix `HoverCard` rather than a hand-rolled
 * `Popover` + mouse-timer pair because the latter ping-pongs when the
 * popover content overlaps the trigger — closing the content makes the
 * cursor "re-enter" the trigger and re-open immediately. HoverCard
 * handles the trigger ↔ content boundary correctly.
 *
 * Desktop: hover the colored token → card opens after ~`openDelay` ms and
 * stays open while the cursor is inside the trigger or the content;
 * leaving both with no immediate re-entry closes it.
 *
 * Mobile: HoverCard primitive on touch devices opens on tap; tapping the
 * card backdrop closes it. The `Link` inside is tap-targetable.
 *
 * The trigger span is `pointer-events-auto` so it can capture hover even
 * though the surrounding overlay is `pointer-events-none` (the textarea
 * underneath must stay interactive).
 */
type SkillTokenPopoverProps = {
  /** The colored token span the user sees in the overlay. */
  trigger: ReactNode
  /** Headline copy explaining the problem ("Skill is disabled", etc.). */
  message: string
  /** Action label rendered as a router `Link` ("Enable" / "Create it"). */
  actionLabel: string
  /** Router state payload to send to `/settings/skills`. */
  state: { editSkill: string } | { createSkill: string }
}

const openDelayMs = 120
const closeDelayMs = 180

export const SkillTokenPopover = ({ trigger, message, actionLabel, state }: SkillTokenPopoverProps) => {
  const skillsUrl = useWorkspaceUrl('/settings/skills')
  return (
    <HoverCard openDelay={openDelayMs} closeDelay={closeDelayMs}>
      <HoverCardTrigger asChild>
        <span className="pointer-events-auto cursor-help" tabIndex={0}>
          {trigger}
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={6}
        className="flex w-auto max-w-xs flex-col gap-2 p-3 text-[length:var(--font-size-sm)]"
      >
        <p className="text-foreground">{message}</p>
        <Link to={skillsUrl} state={state} className="underline underline-offset-2 hover:text-foreground">
          {actionLabel}
        </Link>
      </HoverCardContent>
    </HoverCard>
  )
}
