/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * Hover-shows / hover-stays popover anchored to a slash token in the chat
 * input overlay. The Radix `Tooltip` primitive closes on mouse-leave even
 * if you're moving into the tooltip's own content, which would prevent the
 * user from clicking the embedded Enable / Create link — so this is a
 * `Popover` with manual mouse-enter / mouse-leave timing instead.
 *
 * The colored token span is `pointer-events-auto` (the overlay it sits in
 * is `pointer-events-none`). Hovering or focusing the token opens the
 * popover; the popover stays open while the cursor is inside either the
 * token or the content; clicking the link inside closes it implicitly by
 * navigating away.
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

const closeDelayMs = 200

export const SkillTokenPopover = ({ trigger, message, actionLabel, state }: SkillTokenPopoverProps) => {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const scheduleClose = () => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, closeDelayMs)
  }

  // Kill the pending close-timer if the popover unmounts mid-hover (e.g. the
  // user edits the token away). React would otherwise warn about a setState
  // on an unmounted component.
  useEffect(() => () => cancelClose(), [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className="pointer-events-auto cursor-help"
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
          onFocus={() => {
            cancelClose()
            setOpen(true)
          }}
          onBlur={scheduleClose}
          tabIndex={0}
        >
          {trigger}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="flex w-auto max-w-xs flex-col gap-2 p-3 text-[length:var(--font-size-sm)]"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <p className="text-foreground">{message}</p>
        <Link to="/settings/skills" state={state} className="underline underline-offset-2 hover:text-foreground">
          {actionLabel}
        </Link>
      </PopoverContent>
    </Popover>
  )
}
