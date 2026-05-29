/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { File, ListOrdered, Pin, Plus } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Pinned-skill chip shown above the chat input. Click → adds the slash
 * token to the input (does not auto-submit). Right-click / long-press on
 * mobile → context menu with add-to-chat / add-instructions / reorder /
 * unpin.
 */
export const SuggestionChip = ({
  label,
  dimmed,
  onClick,
  onOpenChange,
  onAddInstruction,
  onReorder,
  onUnpin,
}: {
  /** Display label — the bare slug; the leading `/` is added at render time. */
  label: string
  dimmed: boolean
  onClick: () => void
  onOpenChange?: (open: boolean) => void
  onAddInstruction: () => void
  onReorder: () => void
  onUnpin: () => void
}) => {
  const [open, setOpen] = useState(false)
  const { isMobile } = useIsMobile()

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

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
  // `handleOpenChange(true)` on a gone component (React warns; harmless but
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
        handleOpenChange(true)
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
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
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
            handleOpenChange(true)
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
          className={`h-[var(--touch-height-sm)] shrink-0 cursor-pointer select-none rounded-full bg-card px-3 text-sm font-normal transition-opacity [-webkit-touch-callout:none] ${
            dimmed ? 'opacity-40' : ''
          }`}
          aria-label={`Pinned skill /${label}`}
        >
          /{label}
        </Button>
      </DropdownMenuTrigger>
      {/*
        Anchor the menu's bottom-left to the chip's top-left so the popup
        opens upward from the chip's anchor corner — matches the
        ModeSelector dropdown shape elsewhere on the chat screen, including
        its `rounded-2xl` border-radius.
      */}
      <DropdownMenuContent
        side="top"
        align="start"
        collisionPadding={16}
        className={isMobile ? 'w-[calc(100vw-2rem)] min-w-56 rounded-2xl' : 'min-w-56 rounded-2xl'}
      >
        <DropdownMenuItem
          onSelect={() => {
            onClick()
            handleOpenChange(false)
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <Plus />
          Add to chat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            onAddInstruction()
            handleOpenChange(false)
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <File />
          Add instructions to chat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            // Close before triggering reorder mode — the parent unmounts the
            // chip when entering reorder, so Radix's automatic
            // `onOpenChange(false)` may not reach `setOpenChipId(null)` and
            // would leave sibling chips visually dimmed.
            handleOpenChange(false)
            onReorder()
          }}
          className="min-h-[var(--min-touch-height)] cursor-pointer"
        >
          <ListOrdered />
          Reorder
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            // Same reasoning as Reorder: unpinning unmounts the chip, so we
            // close the menu first to guarantee the dim-state callback fires.
            handleOpenChange(false)
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
