/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import type { RefObject } from 'react'
import { Dialog } from '@/components/ui/dialog'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { AttestationPanel } from './attestation-panel'
import { AttestationStatusIcon } from './attestation-status-icon'
import { useAttestationDisplay } from './use-attestation-display'
import type { AttestationControlProps } from './props'

/** The menu row unmounts on opening, so focus returns to the persistent selector. */
export const AttestationModal = ({
  target,
  state,
  onVerify,
  hour12,
  open,
  onOpenChange,
  returnFocusRef,
}: AttestationControlProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
}) => {
  const { t } = useLingui()
  const { status, label } = useAttestationDisplay(target, state)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContentComposable
        className="md:max-h-[85vh] sm:max-w-md"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocusRef.current?.focus()
        }}
      >
        <ResponsiveModalHeader className="mb-0">
          <ResponsiveModalTitle
            className="flex items-center justify-center gap-2"
            aria-live="polite"
            aria-atomic="true"
          >
            <AttestationStatusIcon status={status} className="size-5 shrink-0" />
            {status === 'verified' ? t`Connection Verified` : label}
          </ResponsiveModalTitle>
        </ResponsiveModalHeader>
        <AttestationPanel target={target} state={state} onVerify={onVerify} hour12={hour12} />
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
