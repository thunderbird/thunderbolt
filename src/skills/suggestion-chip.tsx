/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { File, ListOrdered, Pin, Plus, SquarePen } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'

import { Button } from '@/components/ui/button'
import { ResponsiveActionMenu, type ResponsiveActionMenuAction } from '@/components/ui/responsive-action-menu'
import { cn } from '@/lib/utils'

/**
 * Shared pill surface for the pinned-skill chips and the `+` add button in
 * the chat skills bar. Full-accent hover: anything softer (accent/50 over
 * the chip's near-white resting bg) composites to almost exactly the page
 * background, making the pill vanish on hover. Dark needs the explicit
 * accent too — Button's dark:hover:bg-card/50 is the same color as the
 * chip's resting bg-sidebar, i.e. no feedback.
 */
export const chipSurfaceClass =
  'shrink-0 cursor-pointer rounded-full border-none bg-sidebar text-muted-foreground shadow-glow-sm hover:bg-accent hover:text-foreground dark:bg-sidebar dark:hover:bg-accent'

/**
 * Pinned-skill chip shown above the chat input. Click → adds the slash
 * token to the input (does not auto-submit). Right-click / long-press on
 * mobile → context menu with add-to-chat / add-instructions plus optional
 * edit / reorder / unpin actions for mutable skills.
 */
export const SuggestionChip = ({
  label,
  onClick,
  onAddInstruction,
  onEdit,
  onReorder,
  onUnpin,
}: {
  /** Human display name of the pinned skill (no slash — chips read as names,
   *  the `/slug` form lives in the composer's token badges). */
  label: string
  onClick: () => void
  onAddInstruction: () => void
  /** Open the route-preserving skill editor. */
  onEdit?: () => void
  onReorder?: () => void
  onUnpin?: () => void
}) => {
  const [open, setOpen] = useState(false)

  // Long-press detection for touch — opens the action menu without firing
  // the chip-insertion onClick. Mouse left-clicks fall through to onClick.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  // If the chip unmounts mid-press, kill the pending timer so it can't fire
  // `setOpen(true)` on a gone component (React warns; harmless but
  // noisy in dev).
  useEffect(() => clearLongPress, [])

  // `DropdownMenuTrigger` opens the menu on pointer-down for primary clicks,
  // which would conflict with our click-to-insert affordance. Calling
  // `preventDefault()` on pointer-down for primary clicks short-circuits the
  // trigger's open behavior (Radix checks `defaultPrevented` before opening)
  // while still letting the subsequent `click` event fire normally.
  const handleTriggerPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'touch') {
      longPressFiredRef.current = false
      clearLongPress()
      longPressTimerRef.current = setTimeout(() => {
        longPressFiredRef.current = true
        setOpen(true)
      }, 500)
      // Block Radix from opening on touch — we manage open via long-press.
      e.preventDefault()
      return
    }
    if (e.button === 0) {
      // Mouse left-click: block Radix's open-on-pointer-down behavior so that
      // only the subsequent `click` (which fires onClick) reaches us.
      e.preventDefault()
    }
    // Right-click (button=2) falls through; `onContextMenu` handles it below.
  }

  const handleClick = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false
      return
    }
    onClick()
  }

  const trigger = (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      onPointerDown={handleTriggerPointerDown}
      onPointerUp={clearLongPress}
      onPointerLeave={clearLongPress}
      onPointerCancel={clearLongPress}
      data-long-press=""
      onContextMenu={(event) => {
        event.preventDefault()
        clearLongPress()
        setOpen(true)
      }}
      className={cn(chipSurfaceClass, 'h-[var(--touch-height-sm)] px-3 text-sm font-normal')}
      aria-label={`Pinned skill ${label}`}
    >
      {label}
    </Button>
  )

  const actions: ResponsiveActionMenuAction[] = [
    { label: 'Add to chat', icon: <Plus className="size-[var(--icon-size-sm)]" />, onSelect: onClick },
    {
      label: 'Add instructions to chat',
      icon: <File className="size-[var(--icon-size-sm)]" />,
      onSelect: onAddInstruction,
    },
    ...(onEdit
      ? [{ label: 'Edit skill', icon: <SquarePen className="size-[var(--icon-size-sm)]" />, onSelect: onEdit }]
      : []),
    ...(onReorder
      ? [{ label: 'Reorder', icon: <ListOrdered className="size-[var(--icon-size-sm)]" />, onSelect: onReorder }]
      : []),
    ...(onUnpin ? [{ label: 'Unpin', icon: <Pin className="size-[var(--icon-size-sm)]" />, onSelect: onUnpin }] : []),
  ]

  return (
    <ResponsiveActionMenu
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={label}
      actions={actions}
      // The chip's click inserts the slash token; the menu opens via
      // long-press / right-click handled on the trigger itself.
      openOnTriggerClickMobile={false}
      desktopMenu={{
        side: 'top',
        align: 'start',
        // 8px matches the pb-2 gap between the chips bar and the composer;
        // 12px keeps the panel off the screen edge on narrow desktop windows.
        sideOffset: 8,
        collisionPadding: 12,
        className: 'w-60',
      }}
    />
  )
}
