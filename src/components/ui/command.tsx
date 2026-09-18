/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { type ComponentProps } from 'react'
import { Command as CommandPrimitive } from 'cmdk'
import { SearchIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MobileCardMenu } from '@/components/ui/mobile-card-menu'
import { useIsMobile } from '@/hooks/use-mobile'

const Command = ({ className, ...props }: ComponentProps<typeof CommandPrimitive>) => {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-xl',
        className,
      )}
      {...props}
    />
  )
}

const CommandDialog = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  showCloseButton = true,
  shouldFilter,
  ...props
}: ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  /** Forwarded to cmdk. Pass `false` when the item list is already filtered upstream. */
  shouldFilter?: boolean
}) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const dialogTitle = title ?? t`Command Palette`
  const dialogDescription = description ?? t`Search for a command to run…`

  const command = (
    <Command
      shouldFilter={shouldFilter}
      className={cn(
        '[&_[cmdk-group-heading]]:text-muted-foreground **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5',
        // Inside the drawer the sheet itself owns the surface (translucent
        // bg-popover/80 + blur). Drop the command's own opaque bg and rounding
        // so the status-bar and handle areas read as one continuous surface,
        // matching the agent picker — otherwise an opaque card floats inside it.
        isMobile && 'bg-transparent rounded-none',
      )}
    >
      {children}
    </Command>
  )

  // On mobile the palette drops in as a top sheet (matching the agent picker),
  // not a centered dialog — same `MobileCardMenu` drawer, opened programmatically.
  if (isMobile) {
    return (
      <MobileCardMenu
        open={open ?? false}
        onOpenChange={onOpenChange ?? (() => {})}
        side="top"
        title={dialogTitle}
        // Focus the search input on open, matching the desktop dialog (which
        // Radix auto-focuses). `true` targets the drawer's first tabbable
        // element — the CommandInput — so the keyboard is ready to type.
        initialFocus
      >
        {command}
      </MobileCardMenu>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{dialogTitle}</DialogTitle>
        <DialogDescription>{dialogDescription}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          'overflow-hidden p-0',
          // Center the shared close X against the 48px (h-12) command-input row.
          // DialogContent's inline `top:16px` is tuned for its p-6 title layout;
          // the important override wins over that inline style.
          '[&_[data-slot=dialog-close]]:top-0! md:[&_[data-slot=dialog-close]]:top-2!',
          className,
        )}
        showCloseButton={showCloseButton}
      >
        {command}
      </DialogContent>
    </Dialog>
  )
}

const CommandInput = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) => {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-[var(--touch-height-default)] items-center gap-2 border-b px-3"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'placeholder:text-muted-foreground flex h-10 w-full rounded-lg bg-transparent py-3 text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

const CommandList = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) => {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto', className)}
      {...props}
    />
  )
}

const CommandEmpty = ({ ...props }: ComponentProps<typeof CommandPrimitive.Empty>) => {
  return <CommandPrimitive.Empty data-slot="command-empty" className="py-6 text-center text-sm" {...props} />
}

const CommandGroup = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) => {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-items]>*+*]:mt-0.5',
        className,
      )}
      {...props}
    />
  )
}

const CommandSeparator = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) => {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('bg-border -mx-1 h-px', className)}
      {...props}
    />
  )
}

const CommandItem = ({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) => {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[length:var(--font-size-body)] outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

const CommandShortcut = ({ className, ...props }: ComponentProps<'span'>) => {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('text-muted-foreground ml-auto text-xs tracking-widest', className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
