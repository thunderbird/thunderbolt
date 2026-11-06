/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { AttestationModal } from './attestation-modal'
import { AttestationStatusIcon } from './attestation-status-icon'
import { useAttestationDisplay } from './use-attestation-display'
import type { AttestationControlProps } from './props'

/** A separate privacy entry for agents that own their model connection. */
export const AttestationControl = (props: AttestationControlProps) => {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { status, label } = useAttestationDisplay(props.target, props.state)
  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t`Connection privacy: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className="size-[var(--touch-height-control)] rounded-[var(--radius-control)] text-muted-foreground hover:bg-accent/50"
        onClick={() => setOpen(true)}
      >
        <AttestationStatusIcon status={status} className="size-3.5" />
      </Button>
      <AttestationModal {...props} open={open} onOpenChange={setOpen} returnFocusRef={triggerRef} />
    </>
  )
}
