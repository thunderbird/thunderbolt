/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { File, ListOrdered, Pin, Play, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useIsMobile } from '@/hooks/use-mobile'

export const SuggestionChip = ({
  label,
  dimmed,
  onClick,
  onOpenChange,
  runHref,
  onAddInstruction,
  onReorder,
  onUnpin,
}: {
  label: string
  dimmed: boolean
  onClick: () => void
  onOpenChange?: (open: boolean) => void
  runHref: string
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

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={onClick}
          onContextMenu={(e) => {
            e.preventDefault()
            handleOpenChange(true)
          }}
          className={`h-8 shrink-0 rounded-full bg-card px-3 text-sm font-normal transition-opacity ${
            dimmed ? 'opacity-40' : ''
          }`}
        >
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className={
          isMobile
            ? 'flex w-[calc(100vw-2rem)] flex-col gap-0 rounded-xl border border-border-strong bg-card px-2 py-3'
            : 'flex flex-col gap-0 rounded-xl border border-border-strong bg-card px-2 py-3'
        }
      >
        <DropdownMenuItem asChild className="h-11 gap-1.5 px-2 text-sm md:h-9 [&_svg:not([class*='size-'])]:size-4">
          <Link to={runHref}>
            <Play />
            Run skill
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onClick}
          className="h-11 gap-1.5 px-2 text-sm md:h-9 [&_svg:not([class*='size-'])]:size-4"
        >
          <Plus />
          Add to chat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onAddInstruction}
          className="h-11 gap-1.5 px-2 text-sm md:h-9 [&_svg:not([class*='size-'])]:size-4"
        >
          <File />
          Add instructions to chat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onReorder}
          className="h-11 gap-1.5 px-2 text-sm md:h-9 [&_svg:not([class*='size-'])]:size-4"
        >
          <ListOrdered />
          Reorder
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onUnpin}
          className="h-11 gap-1.5 px-2 text-sm md:h-9 [&_svg:not([class*='size-'])]:size-4"
        >
          <Pin />
          Unpin
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
