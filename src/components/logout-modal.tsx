/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
import { clearLocalData } from '@/lib/cleanup'

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

    try {
      await authClient.signOut()
    } catch (error) {
      console.error('Failed to sign out:', error)
    }

    try {
      await clearLocalData({ clearDatabase: selectedOption === 'delete' })
    } catch (error) {
      console.error('Failed to clear local data:', error)
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
