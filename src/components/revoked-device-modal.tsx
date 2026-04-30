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
import { clearLocalData } from '@/lib/cleanup'

type RevokedDeviceModalProps = {
  open: boolean
}

export const RevokedDeviceModal = ({ open }: RevokedDeviceModalProps) => {
  const [selectedOption, setSelectedOption] = useState<DataOption>('keep')
  const [isProcessing, setIsProcessing] = useState(false)

  const handleConfirm = async () => {
    setIsProcessing(true)
    await clearLocalData({ clearDatabase: selectedOption === 'delete' })
    window.location.replace('/')
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={() => {}}
      showCloseButton={false}
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
    >
      <ResponsiveModalHeader>
        <ResponsiveModalTitle>Device access revoked</ResponsiveModalTitle>
        <ResponsiveModalDescription>
          This device has been signed out remotely. Choose what to do with your local data.
        </ResponsiveModalDescription>
      </ResponsiveModalHeader>

      <ResponsiveModalContent centered className="gap-3">
        <SelectableCard
          selected={selectedOption === 'keep'}
          onSelect={() => setSelectedOption('keep')}
          icon={<HardDrive className="h-5 w-5" />}
          title="Keep data on device"
          description="Your chats and settings will remain on this device for offline use."
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
        <Button
          variant={selectedOption === 'delete' ? 'destructive' : 'default'}
          onClick={handleConfirm}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {selectedOption === 'delete' ? 'Deleting...' : 'Signing out...'}
            </>
          ) : (
            'Confirm'
          )}
        </Button>
      </ResponsiveModalFooter>
    </ResponsiveModal>
  )
}
