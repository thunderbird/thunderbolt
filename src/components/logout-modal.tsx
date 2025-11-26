'use client'

import { HardDrive, Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { authClient } from '@/lib/auth-client'
import { resetAppDir } from '@/lib/fs'
import { cn } from '@/lib/utils'

type LogoutModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type DataOption = 'keep' | 'delete'

type SelectableCardProps = {
  selected: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  description: string
  variant?: 'default' | 'destructive'
}

const SelectableCard = ({ selected, onSelect, icon, title, description, variant = 'default' }: SelectableCardProps) => {
  const isDestructive = variant === 'destructive'

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-4 rounded-lg border-2 p-4 text-left transition-all',
        'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && !isDestructive && 'border-primary bg-primary/5',
        selected && isDestructive && 'border-destructive bg-destructive/5',
        !selected && 'border-border',
      )}
    >
      {/* Radio circle indicator */}
      <div
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
          selected && !isDestructive && 'border-primary',
          selected && isDestructive && 'border-destructive',
          !selected && 'border-muted-foreground/50',
        )}
      >
        {selected && (
          <div className={cn('h-2.5 w-2.5 rounded-full', isDestructive ? 'bg-destructive' : 'bg-primary')} />
        )}
      </div>

      {/* Icon */}
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
          isDestructive ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1">
        <p className={cn('font-medium', isDestructive && selected && 'text-destructive')}>{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}

export const LogoutModal = ({ open, onOpenChange }: LogoutModalProps) => {
  const [selectedOption, setSelectedOption] = useState<DataOption>('keep')
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)

    try {
      // Sign out first (clears backend session)
      await authClient.signOut()
    } catch (error) {
      console.error('Failed to sign out:', error)
      // Continue anyway - we still want to delete data and reload if requested
    }

    try {
      // Delete local data if requested
      if (selectedOption === 'delete') {
        await resetAppDir()
      }
    } catch (error) {
      console.error('Failed to delete local data:', error)
      // Continue anyway - still reload to get a clean state
    }

    // Always reload to ensure clean app state
    window.location.reload()
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (isLoggingOut) return // Prevent closing while logging out
    if (!newOpen) {
      setSelectedOption('keep')
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log out</DialogTitle>
          <DialogDescription>What would you like to do with your local data?</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-4">
          <SelectableCard
            selected={selectedOption === 'keep'}
            onSelect={() => setSelectedOption('keep')}
            icon={<HardDrive className="h-5 w-5" />}
            title="Leave data on device"
            description="Your chats and settings will remain on this device for next time."
          />

          <SelectableCard
            selected={selectedOption === 'delete'}
            onSelect={() => setSelectedOption('delete')}
            icon={<Trash2 className="h-5 w-5" />}
            title="Delete local data"
            description="Remove all chats, settings, and cached data from this device."
            variant="destructive"
          />
        </div>

        <DialogFooter className="flex-row gap-2 sm:justify-end">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoggingOut}>
            Cancel
          </Button>
          <Button
            variant={selectedOption === 'delete' ? 'destructive' : 'default'}
            onClick={handleLogout}
            disabled={isLoggingOut}
          >
            {isLoggingOut ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {selectedOption === 'delete' ? 'Deleting...' : 'Logging out...'}
              </>
            ) : (
              'Log out'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
