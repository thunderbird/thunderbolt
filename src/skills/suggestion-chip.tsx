/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { File, ListOrdered, Pin, Plus, SquarePen } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'
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
 * mobile → context menu with add-to-chat / add-instructions / edit /
 * reorder / unpin.
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
  /** Jump to the skill's edit form in `/settings/skills`. */
  onEdit: () => void
  onReorder: () => void
  onUnpin: () => void
}) => {
  const [open, setOpen] = useState(false)
  const { isMobile } = useIsMobile()

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

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleClick}
          onPointerDown={handleTriggerPointerDown}
          onPointerUp={clearLongPress}
          onPointerLeave={clearLongPress}
          onPointerCancel={clearLongPress}
          onContextMenu={(e) => {
            e.preventDefault()
            clearLongPress()
            setOpen(true)
          }}
          // `h-[var(--touch-height-sm)]` resolves to 40px on mobile, 32px on
          // desktop — keeps the compact desktop look while meeting the
          // 40px-min touch target the rest of the app uses on touch devices.
          //
          // `select-none` + `[-webkit-touch-callout:none]` suppress the OS
          // text-selection that fires on long-press on iOS / Android. Without
          // them the chip's label gets highlighted (and on iOS the system
          // share/copy callout pops) while our long-press timer is waiting
          // to open the action menu. Leaving `touch-action` at its default
          // so the chip strip's horizontal scroll on mobile still works.
          className={cn(
            chipSurfaceClass,
            'h-[var(--touch-height-sm)] select-none px-3 text-sm font-normal [-webkit-touch-callout:none]',
          )}
          aria-label={`Pinned skill ${label}`}
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      {/*
        Anchor the menu's bottom-left to the chip's top-left so the popup
        opens upward from the chip's anchor corner. Container and item
        styling inherit the DropdownMenu defaults (`rounded-xl` panel,
        `rounded-md` items), minus the drop shadow — the menu should read
        as a flat, ordinary menu over the chat screen.
      */}
      <DropdownMenuContent
        side="top"
        align="start"
        // `sideOffset={8}` matches the `pb-2` (8px) gap between the chips bar
        // and the chat composer below it, so the menu sits off the chip by
        // the same distance the chip sits off the composer.
        sideOffset={8}
        // 12px collision padding + 100vw-1.5rem width on mobile makes the menu
        // exactly as wide as the chat composer (which sits at px-3 insets).
        collisionPadding={12}
        className={isMobile ? 'w-[calc(100vw-1.5rem)] min-w-56' : 'min-w-56'}
      >
        <DropdownMenuItem
          onSelect={() => {
            onClick()
            setOpen(false)
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <Plus />
          Add to chat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            onAddInstruction()
            setOpen(false)
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <File />
          Add instructions to chat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setOpen(false)
            onEdit()
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <SquarePen />
          Edit skill
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setOpen(false)
            onReorder()
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <ListOrdered />
          Reorder
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            setOpen(false)
            onUnpin()
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <Pin />
          Unpin
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
