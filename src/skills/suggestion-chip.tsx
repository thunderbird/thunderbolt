/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { File, ListOrdered, Pin, Play, Plus } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * Pinned-skill chip shown above the chat input. Click → adds the slash
 * token to the input (does not auto-submit). Right-click / long-press on
 * mobile → context menu with run / add-to-chat / reorder / unpin.
 *
 * "Run skill" navigates via router state (not a URL) so the entry point
 * stays internal — Skills v1 §5 explicitly forbids `?run=` URL surfaces.
 */
export const SuggestionChip = ({
  label,
  dimmed,
  onClick,
  onOpenChange,
  onRun,
  onAddInstruction,
  onReorder,
  onUnpin,
}: {
  /** Display label — the bare slug; the leading `/` is added at render time. */
  label: string
  dimmed: boolean
  onClick: () => void
  onOpenChange?: (open: boolean) => void
  onRun: () => void
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
          className={`h-8 shrink-0 cursor-pointer rounded-full bg-card px-3 text-sm font-normal transition-opacity ${
            dimmed ? 'opacity-40' : ''
          }`}
          aria-label={`Pinned skill /${label}`}
        >
          /{label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        collisionPadding={16}
        className={isMobile ? 'w-[calc(100vw-2rem)] min-w-56' : 'min-w-56'}
      >
        <DropdownMenuItem
          onSelect={() => {
            onRun()
            handleOpenChange(false)
          }}
          className="cursor-pointer"
        >
          <Play />
          Run skill
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            onClick()
            handleOpenChange(false)
          }}
          className="cursor-pointer"
        >
          <Plus />
          Add to chat
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddInstruction} className="cursor-pointer">
          <File />
          Add instructions to chat
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onReorder} className="cursor-pointer">
          <ListOrdered />
          Reorder
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onUnpin} className="cursor-pointer">
          <Pin />
          Unpin
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
