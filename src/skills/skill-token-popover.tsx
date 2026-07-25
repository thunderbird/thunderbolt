/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'

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
  /** Action label rendered as a link or button ("Enable" / "Create it"). */
  actionLabel: string
} & (
  | {
      /** Router state payload for actions that still need the settings screen. */
      state: { editSkill: string }
      onAction?: never
    }
  | {
      /** Route-preserving action such as opening the global create surface. */
      onAction: () => void
      state?: never
    }
)

const openDelayMs = 120
const closeDelayMs = 180

export const SkillTokenPopover = (props: SkillTokenPopoverProps) => {
  const { trigger, message, actionLabel } = props
  const onAction = props.onAction
  const [open, setOpen] = useState(false)

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={openDelayMs} closeDelay={closeDelayMs}>
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
        {onAction ? (
          <button
            type="button"
            className="cursor-pointer text-left underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              setOpen(false)
              onAction()
            }}
          >
            {actionLabel}
          </button>
        ) : (
          <Link
            to="/settings/skills"
            state={props.state}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {actionLabel}
          </Link>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
