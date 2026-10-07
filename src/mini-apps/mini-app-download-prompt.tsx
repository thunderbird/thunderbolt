/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { isTauri } from '@/lib/platform'
import type { PendingMiniAppDownload } from './use-mini-app-bridge'

/**
 * How long Save stays disabled after a prompt opens. An app can ask again the
 * moment the previous file is saved, and without this the second click of a
 * double-click would approve a file nobody read. Firefox holds its own
 * download and install prompts the same way.
 */
export const saveArmDelayMs = 750

type MiniAppDownloadPromptProps = {
  appName: string
  /** The save waiting on the user, or null when none is. */
  download: PendingMiniAppDownload | null
  onAnswer: (approved: boolean) => void
}

/**
 * Asks before a Mini App saves a file, as MCP Apps asks hosts to.
 *
 * Says where the file goes because on desktop nothing else will: the webview
 * has no download bar, so this sentence is the only record of the save.
 */
export const MiniAppDownloadPrompt = ({ appName, download, onAnswer }: MiniAppDownloadPromptProps) => {
  const { t } = useLingui()
  // Keeps the name on screen while the dialog animates closed, after `download` is null.
  const shown = useRef(download)
  if (download) {
    shown.current = download
  }
  const fileName = shown.current?.name ?? ''

  // The prompt Save is armed for. A new request is a new object, so it starts disarmed.
  const [armedFor, setArmedFor] = useState<PendingMiniAppDownload | null>(null)
  useEffect(() => {
    if (!download) {
      return
    }
    const timer = setTimeout(() => setArmedFor(download), saveArmDelayMs)
    return () => clearTimeout(timer)
  }, [download])

  return (
    <ConfirmActionDialog
      open={download !== null}
      title={t`Save a file from ${appName}?`}
      description={
        isTauri() ? t`${fileName} will be saved to your Downloads folder.` : t`Your browser will download ${fileName}.`
      }
      confirmLabel={t`Save`}
      confirmVariant="default"
      confirmDisabled={download === null || armedFor !== download}
      onConfirm={() => onAnswer(true)}
      onCancel={() => onAnswer(false)}
    />
  )
}
