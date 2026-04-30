/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Download, RefreshCw, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDesktopUpdate, type UpdateStatus } from '@/hooks/use-desktop-update'
import { Button } from '@/components/ui/button'
import { isDesktop } from '@/lib/platform'

const statusConfig: Record<UpdateStatus, { icon: typeof Download; message: string; showActions: boolean }> = {
  idle: { icon: CheckCircle, message: '', showActions: false },
  checking: { icon: Loader2, message: 'Checking for updates...', showActions: false },
  available: { icon: Download, message: 'A new version is available!', showActions: true },
  downloading: { icon: Loader2, message: 'Downloading update...', showActions: false },
  ready: { icon: RefreshCw, message: 'Update ready! Restart to apply.', showActions: true },
  error: { icon: AlertCircle, message: 'Update failed', showActions: true },
}

export const UpdateNotification = () => {
  const { status, update, error, downloadAndInstall, restartApp, checkForUpdates } = useDesktopUpdate()
  const [dismissed, setDismissed] = useState(false)

  // Only show on desktop platforms
  if (!isDesktop()) {
    return null
  }

  const isVisible = !dismissed && status !== 'idle' && status !== 'checking'
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
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="update-notification"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 right-4 z-50 max-w-sm"
        >
          <div className="bg-card border border-border rounded-lg shadow-lg p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <Icon
                  className={`size-5 ${status === 'downloading' ? 'animate-spin' : ''} ${
                    status === 'error' ? 'text-destructive' : 'text-primary'
                  }`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{config.message}</p>

                {status === 'available' && update && (
                  <p className="text-xs text-muted-foreground mt-1">Version {update.version}</p>
                )}

                {status === 'error' && error && <p className="text-xs text-destructive mt-1">{error}</p>}

                {config.showActions && (
                  <div className="flex gap-2 mt-3">
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
                  </div>
                )}
              </div>

              <button
                onClick={handleDismiss}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-label="Dismiss"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
