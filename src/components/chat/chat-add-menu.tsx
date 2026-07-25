/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Paperclip, Plug, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MobileCardMenu } from '@/components/ui/mobile-card-menu'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

type ChatAddMenuProps = {
  onUploadFile: () => void
  onOpenConnections: () => void
}

export const ChatAddMenu = ({ onUploadFile, onOpenConnections }: ChatAddMenuProps) => {
  const [open, setOpen] = useState(false)
  const { isMobile } = useIsMobile()

  const actions: { label: string; icon: ReactNode; onSelect: () => void }[] = [
    {
      label: 'Upload file',
      icon: <Paperclip className="size-[var(--icon-size-sm)] text-muted-foreground" />,
      onSelect: onUploadFile,
    },
    {
      label: 'Connections',
      icon: <Plug className="size-[var(--icon-size-sm)] text-muted-foreground" />,
      onSelect: onOpenConnections,
    },
  ]

  const trigger = (
    <button
      type="button"
      aria-label="Add to chat"
      title="Add to chat"
      aria-expanded={open}
      className={cn(
        'flex size-[var(--touch-height-control)] shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
        isMobile && open && 'bg-accent text-foreground',
      )}
      onClick={isMobile ? () => setOpen(!open) : undefined}
    >
      <Plus className="size-[var(--icon-size-sm)]" />
    </button>
  )

  if (isMobile) {
    return (
      <>
        {trigger}
        <MobileCardMenu open={open} onOpenChange={setOpen} title="Add to chat">
          <div className="flex flex-col gap-0.5 px-1 pb-1">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="flex min-h-[var(--min-touch-height)] w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-left text-[length:var(--font-size-body)] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                onClick={() => {
                  setOpen(false)
                  action.onSelect()
                }}
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </MobileCardMenu>
      </>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="min-w-44">
        {actions.map((action) => (
          <DropdownMenuItem key={action.label} onSelect={action.onSelect} className="cursor-pointer">
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
