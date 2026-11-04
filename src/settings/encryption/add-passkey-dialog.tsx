/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PasskeyEnrollStep } from '@/components/sync-setup/passkey-enroll-step'
import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalTitle } from '@/components/ui/responsive-modal'
import { Trans } from '@lingui/react/macro'
import { useState } from 'react'

type AddPasskeyDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** This device holds the sync keys, so the passkey can also unlock sync. */
  unlocksSync: boolean
}

/** Adds the account's passkey from Preferences, for accounts that have none. */
export const AddPasskeyDialog = ({ open, onOpenChange, unlocksSync }: AddPasskeyDialogProps) => {
  const [isEnrolling, setIsEnrolling] = useState(false)

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(isOpen) => !isEnrolling && onOpenChange(isOpen)}
      className="sm:min-h-0 sm:h-auto"
      showCloseButton={!isEnrolling}
    >
      <ResponsiveModalTitle className="sr-only">
        <Trans>Add a passkey</Trans>
      </ResponsiveModalTitle>
      <ResponsiveModalContent>
        <PasskeyEnrollStep unlocksSync={unlocksSync} onDone={() => onOpenChange(false)} onBusyChange={setIsEnrolling} />
      </ResponsiveModalContent>
    </ResponsiveModal>
  )
}
