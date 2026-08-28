/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { HandleError } from '@/types/handle-errors'

/**
 * Generates a support email with error details and stack traces
 */
const generateSupportEmail = (error: HandleError) => {
  const subject = 'App Initialization Error'
  let body = `Error Code: ${error.code}\nError Message: ${error.message}`

  if (error.stackTrace) {
    body += `\n\nStack Trace:\n${error.stackTrace}`
  }

  if (error.originalError && error.originalError instanceof Error && error.originalError.stack) {
    body += `\n\nOriginal Error Stack:\n${error.originalError.stack}`
  }

  return {
    subject: encodeURIComponent(subject),
    body: encodeURIComponent(body),
  }
}

type AppErrorScreenProps = {
  error: HandleError
  isClearingDatabase: boolean
  onClearDatabase: () => void
}

export const AppErrorScreen = ({ error, isClearingDatabase, onClearDatabase }: AppErrorScreenProps) => {
  const isDatabaseError = error.code === 'MIGRATION_FAILED' || error.code === 'DATABASE_INIT_FAILED'

  return (
    <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4">
      <div className="text-red-500 text-center mb-4">
        <Trans>Failed to initialize app</Trans>
      </div>
      <div className="text-sm text-gray-500 text-center mb-6">{error.message}</div>

      <div className="flex flex-col gap-3">
        {isDatabaseError && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={isClearingDatabase}>
                {isClearingDatabase ? <Trans>Clearing Database…</Trans> : <Trans>Clear Local Database</Trans>}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Clear Local Database?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    Unfortunately, the local database encountered an error while being migrated to the latest version of
                    this app. Deleting your local data will resolve the issue but you will permanently lose your
                    settings and chat history. This action cannot be undone.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction onClick={onClearDatabase} variant="destructive">
                  <Trans>Clear Database</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        <Button
          variant="outline"
          onClick={() => {
            const { subject, body } = generateSupportEmail(error)
            window.open(`mailto:support@thunderbird.net?subject=${subject}&body=${body}`)
          }}
        >
          <Trans>Contact Support</Trans>
        </Button>
      </div>
    </div>
  )
}
