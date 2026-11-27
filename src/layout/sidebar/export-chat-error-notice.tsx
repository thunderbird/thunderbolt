/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { NotificationCard } from '@/components/ui/notification-card'
import { useLingui } from '@lingui/react/macro'
import { TriangleAlert } from 'lucide-react'
import { createPortal } from 'react-dom'

type ExportChatErrorNoticeProps = {
  /** Why the export failed, already translated; null hides the notice. */
  errorMessage: string | null
  onDismiss: () => void
}

/** Tells the user a chat export failed. It stays until dismissed, so the reason can be read. */
export const ExportChatErrorNotice = ({ errorMessage, onDismiss }: ExportChatErrorNoticeProps) => {
  const { t } = useLingui()
  const reason = errorMessage ?? ''
  const message = t`Couldn't export the chat: ${reason}`

  return createPortal(
    <>
      <div role="alert" aria-atomic="true" className="sr-only">
        {errorMessage ? message : ''}
      </div>
      <NotificationCard
        open={errorMessage !== null}
        icon={<TriangleAlert className="size-[var(--icon-size-default)] text-destructive" />}
        message={message}
        onDismiss={onDismiss}
      />
    </>,
    document.body,
  )
}
