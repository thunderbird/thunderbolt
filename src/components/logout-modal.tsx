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
import { useAuth } from '@/contexts'
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
        'group relative flex w-full items-center gap-4 rounded-xl border bg-card p-4 text-left transition-all',
        'hover:border-muted-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && !isDestructive && 'border-primary/50 bg-primary/5 shadow-sm shadow-primary/10',
        selected && isDestructive && 'border-destructive/50 bg-destructive/5 shadow-sm shadow-destructive/10',
        !selected && 'border-border hover:bg-accent/30',
      )}
    >
      {/* Radio indicator */}
      <div
        className={cn(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
          selected && !isDestructive && 'border-primary bg-primary',
          selected && isDestructive && 'border-destructive bg-destructive',
          !selected && 'border-muted-foreground/40 group-hover:border-muted-foreground/60',
        )}
      >
        {selected && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
      </div>

      {/* Icon */}
      <div
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors',
          selected && isDestructive && 'bg-destructive/15 text-destructive',
          selected && !isDestructive && 'bg-primary/15 text-primary',
          !selected && 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            'font-medium transition-colors',
            selected && isDestructive && 'text-destructive',
            selected && !isDestructive && 'text-primary',
          )}
        >
          {title}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground line-clamp-2">{description}</p>
      </div>
    </button>
  )
}

export const LogoutModal = ({ open, onOpenChange }: LogoutModalProps) => {
  const authClient = useAuth()
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
            title="Delete data from device"
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
