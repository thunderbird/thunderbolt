/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ResponsiveModal, ResponsiveModalContent, ResponsiveModalTitle } from '@/components/ui/responsive-modal'
import { RecoveryKeyDisplayStep } from '@/components/sync-setup/recovery-key-display-step'

type RecoveryKeyDialogProps = {
  open: boolean
  /** The 24-word mnemonic. Shown exactly once — the caller must not retain it. */
  recoveryKey: string
  title: string
  description: string
  onDone: () => void
}

/**
 * Blocking dialog that shows a freshly generated 24-word recovery phrase
 * exactly once, with the "I have saved my recovery phrase" confirmation gate.
 * Deliberately not dismissable (no close button, no outside click, no Escape):
 * the only way out is confirming the phrase was saved — the old phrase is
 * already dead by the time this renders.
 */
export const RecoveryKeyDialog = ({ open, recoveryKey, title, description, onDone }: RecoveryKeyDialogProps) => (
  <ResponsiveModal
    open={open}
    onOpenChange={() => {}}
    className="sm:min-h-0 sm:h-auto"
    showCloseButton={false}
    onInteractOutside={(e) => e.preventDefault()}
    onEscapeKeyDown={(e) => e.preventDefault()}
  >
    <ResponsiveModalTitle className="sr-only">{title}</ResponsiveModalTitle>
    <ResponsiveModalContent>
      <RecoveryKeyDisplayStep recoveryKey={recoveryKey} onDone={onDone} title={title} description={description} />
    </ResponsiveModalContent>
  </ResponsiveModal>
)
