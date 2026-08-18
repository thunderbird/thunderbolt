/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Download, RefreshCw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useDesktopUpdate, type DesktopUpdateState, type UpdateStatus } from '@/hooks/use-desktop-update'
import { Button } from '@/components/ui/button'
import { NotificationCard } from '@/components/ui/notification-card'
import { isDesktop } from '@/lib/platform'

const statusConfig = {
  initial: { icon: CheckCircle, message: '', showActions: false },
  idle: { icon: CheckCircle, message: '', showActions: false },
  checking: { icon: Loader2, message: 'Checking for updates...', showActions: false },
  available: { icon: Download, message: 'A new version is available!', showActions: true },
  downloading: { icon: Loader2, message: 'Downloading update...', showActions: false },
  ready: { icon: RefreshCw, message: 'Update ready! Restart to apply.', showActions: true },
  error: { icon: AlertCircle, message: 'Update failed', showActions: true },
} satisfies Record<UpdateStatus, { icon: typeof Download; message: string; showActions: boolean }>

type UpdateNotificationContentProps = {
  desktop: boolean
  updateState: DesktopUpdateState
}

export const UpdateNotificationContent = ({ desktop, updateState }: UpdateNotificationContentProps) => {
  const { status, update, error, downloadAndInstall, restartApp, checkForUpdates } = updateState
  const [dismissed, setDismissed] = useState(false)

  if (!desktop) {
    return null
  }

  const isVisible = !dismissed && status !== 'initial' && status !== 'idle' && status !== 'checking'
  const config = statusConfig[status]
  const Icon = config.icon

  const handlePrimaryAction = async () => {
    if (status === 'available') {
      await downloadAndInstall()
    } else if (status === 'ready') {
      await restartApp()
    } else if (status === 'error') {
      await checkForUpdates()
    }
  }

  const handleDismiss = () => {
    setDismissed(true)
  }

  return (
    <NotificationCard
      open={isVisible}
      icon={
        <Icon
          className={`size-5 ${status === 'downloading' ? 'animate-spin' : ''} ${
            status === 'error' ? 'text-destructive' : 'text-primary'
          }`}
        />
      }
      message={config.message}
      positionClassName="right-4 max-w-sm"
      details={
        <>
          {status === 'available' && update && (
            <p className="mt-1 text-[length:var(--font-size-xs)] text-muted-foreground">Version {update.version}</p>
          )}
          {status === 'error' && error && (
            <p className="mt-1 text-[length:var(--font-size-xs)] text-destructive">{error}</p>
          )}
        </>
      }
      actions={
        config.showActions ? (
          <>
            <Button size="sm" onClick={handlePrimaryAction}>
              {status === 'available' && 'Download'}
              {status === 'ready' && 'Restart Now'}
              {status === 'error' && 'Retry'}
            </Button>
            {status !== 'error' && (
              <Button size="sm" variant="ghost" onClick={handleDismiss}>
                Later
              </Button>
            )}
          </>
        ) : undefined
      }
      onDismiss={handleDismiss}
      dismissLabel="Dismiss"
    />
  )
}

export const UpdateNotification = () => {
  const updateState = useDesktopUpdate()

  return <UpdateNotificationContent desktop={isDesktop()} updateState={updateState} />
}
