/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { exportChatThread, type UserDataExport } from '@/dal'
import { i18n } from '@/i18n'
import { saveErrorMessage } from '@/lib/download'
import { chatExportFilenameFor, downloadJson } from '@/lib/export-download'
import { trackEvent } from '@/lib/posthog'
import { msg } from '@lingui/core/macro'
import { useCallback, useState } from 'react'

/**
 * Saves one chat as a JSON file that Settings → Preferences → Data → Import Data reads back. A failure is kept for
 * the sidebar to show, since the menu that started the export has closed by then. The error text is translated when
 * it is stored, so it stays in the language the user had at that moment.
 */
export const useExportChat = (db: AnyDrizzleDatabase, attributedTo: UserDataExport['user']) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const { id, email } = attributedTo

  const exportChat = useCallback(
    async (threadId: string) => {
      setErrorMessage(null)
      try {
        const payload = await exportChatThread(db, threadId, { id, email })
        try {
          await downloadJson(chatExportFilenameFor(payload.tables.chat_threads[0].title, new Date()), payload)
        } catch (error) {
          console.error('Failed to save the chat export:', error)
          setErrorMessage(i18n._(saveErrorMessage(error instanceof Error ? error : String(error))))
          return
        }
        trackEvent('chat_export')
      } catch (error) {
        console.error('Failed to read the chat to export:', error)
        setErrorMessage(i18n._(msg`The chat could not be read on this device.`))
      }
    },
    [db, id, email],
  )

  const dismissError = useCallback(() => setErrorMessage(null), [])

  return { exportChat, errorMessage, dismissError }
}
