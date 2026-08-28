/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Download, RefreshCw, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { m, AnimatePresence } from 'framer-motion'
import { useDesktopUpdate, type UpdateStatus } from '@/hooks/use-desktop-update'
import { Button } from '@/components/ui/button'
import { isDesktop } from '@/lib/platform'

const statusConfig: Record<
  UpdateStatus,
  { icon: typeof Download; message: MessageDescriptor | null; showActions: boolean }
> = {
  initial: { icon: CheckCircle, message: null, showActions: false },
  idle: { icon: CheckCircle, message: null, showActions: false },
  checking: { icon: Loader2, message: msg`Checking for updates…`, showActions: false },
  available: { icon: Download, message: msg`A new version is available!`, showActions: true },
  downloading: { icon: Loader2, message: msg`Downloading update…`, showActions: false },
  ready: { icon: RefreshCw, message: msg`Update ready! Restart to apply.`, showActions: true },
  error: { icon: AlertCircle, message: msg`Update failed`, showActions: true },
}

export const UpdateNotification = () => {
  const { i18n, t } = useLingui()
  const { status, update, error, primaryAction } = useDesktopUpdate()
  const updateVersion = update?.version ?? ''
  const [dismissed, setDismissed] = useState(false)

  // Only show on desktop platforms
  if (!isDesktop()) {
    return null
  }

  const isVisible = !dismissed && status !== 'initial' && status !== 'idle' && status !== 'checking'
  const config = statusConfig[status]
  const Icon = config.icon

  const handleDismiss = () => {
    setDismissed(true)
  }

  return (
    <AnimatePresence>
      {isVisible && (
        <m.div
          key="update-notification"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 right-4 z-50 max-w-sm"
        >
          <div className="bg-card border border-border rounded-xl shadow-lg p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <Icon
                  className={`size-5 ${status === 'downloading' ? 'animate-spin' : ''} ${
                    status === 'error' ? 'text-destructive' : 'text-primary'
                  }`}
                />
              </div>

              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{config.message ? i18n._(config.message) : ''}</p>

                {status === 'available' && update && (
                  <p className="text-xs text-muted-foreground mt-1">
                    <Trans>Version {updateVersion}</Trans>
                  </p>
                )}

                {status === 'error' && error && <p className="text-xs text-destructive mt-1">{error}</p>}

                {config.showActions && (
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" onClick={primaryAction}>
                      {status === 'available' && <Trans>Download</Trans>}
                      {status === 'ready' && <Trans>Restart Now</Trans>}
                      {status === 'error' && <Trans>Retry</Trans>}
                    </Button>

                    {status !== 'error' && (
                      <Button size="sm" variant="ghost" onClick={handleDismiss}>
                        <Trans>Later</Trans>
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={handleDismiss}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                aria-label={t`Dismiss`}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  )
}
