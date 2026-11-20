/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { NotificationCard } from '@/components/ui/notification-card'
import { useLingui } from '@lingui/react/macro'
import { CheckCircle2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useSavedFileNoticeState } from './use-saved-file-notice-state'

/**
 * Says where a file went after a save on a phone, which shows no download bar of its own. Mounted once for the app,
 * so every save (a file card, a preview, an export) gets the same notice.
 */
export const SavedFileNotice = () => {
  const { t } = useLingui()
  const { saved, dismiss } = useSavedFileNoticeState()

  // Already made safe by `downloadFile`.
  const name = saved?.name ?? ''
  const message = saved?.platform === 'ios' ? t`Saved ${name} to the Files app.` : t`Saved ${name} to Downloads.`

  return createPortal(
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {saved ? message : ''}
      </div>
      <NotificationCard
        open={saved !== null}
        icon={<CheckCircle2 className="size-[var(--icon-size-default)] text-primary" />}
        message={message}
        onDismiss={dismiss}
      />
    </>,
    document.body,
  )
}
