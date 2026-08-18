/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { NotificationCard } from '@/components/ui/notification-card'
import { CheckCircle2 } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

type ShareDebugTranscriptToastProps = {
  open: boolean
  onDismiss: () => void
}

const successToastDurationMs = 4_000
const successMessage = 'Sent — thank you. This helps the Thunderbolt team see exactly what happened.'

export const ShareDebugTranscriptToast = ({ open, onDismiss }: ShareDebugTranscriptToastProps) => {
  useEffect(() => {
    if (!open) {
      return
    }

    const timeoutId = window.setTimeout(onDismiss, successToastDurationMs)
    return () => window.clearTimeout(timeoutId)
  }, [open, onDismiss])

  return createPortal(
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {open ? successMessage : ''}
      </div>
      <NotificationCard
        open={open}
        icon={<CheckCircle2 className="size-[var(--icon-size-default)] text-primary" />}
        message={successMessage}
        onDismiss={onDismiss}
      />
    </>,
    document.body,
  )
}
