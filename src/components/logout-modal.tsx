import { HardDrive, Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { SelectableCard, type DataOption } from '@/components/ui/selectable-card'
import { useAuth } from '@/contexts'
import { setSyncEnabled } from '@/db/powersync'
import { clearAuthToken, clearDeviceId } from '@/lib/auth-token'
import { resetAppDir } from '@/lib/fs'
import { handleFullWipe } from '@/services/encryption'

type LogoutModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const LogoutModal = ({ open, onOpenChange }: LogoutModalProps) => {
  const authClient = useAuth()
  const [selectedOption, setSelectedOption] = useState<DataOption>('keep')
  const [isLoggingOut, setIsLoggingOut] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)

    // Disable sync before signing out
    try {
      await setSyncEnabled(false)
    } catch (error) {
      console.error('Failed to disable sync:', error)
    }

    // Clear all encryption keys — device ID is also cleared below,
    // so the old key pair is orphaned regardless of keep/delete choice
    try {
      await handleFullWipe()
    } catch (error) {
      console.error('Failed to clear encryption keys:', error)
    }

    try {
      await authClient.signOut()
    } catch (error) {
      console.error('Failed to sign out:', error)
    }

    // Clear local bearer token and device ID (forces new UUID on next login)
    await clearAuthToken()
    clearDeviceId()

    try {
      if (selectedOption === 'delete') {
        await resetAppDir()
      }
    } catch (error) {
      console.error('Failed to delete local data:', error)
    }

    window.location.reload()
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (isLoggingOut) {
      return
    }
    if (!newOpen) {
      setSelectedOption('keep')
    }
    onOpenChange(newOpen)
  }

  return (
    <ResponsiveModal open={open} onOpenChange={handleOpenChange}>
      <ResponsiveModalHeader>
        <ResponsiveModalTitle>Log out</ResponsiveModalTitle>
        <ResponsiveModalDescription>What would you like to do with your local data?</ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <ResponsiveModalContent centered className="gap-3">
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
      </ResponsiveModalContent>

      <ResponsiveModalFooter className="justify-end">
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
      </ResponsiveModalFooter>
    </ResponsiveModal>
  )
}
