/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Download } from 'lucide-react'
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { getDownloadUrl } from '@/lib/download-links'
import { dismissDownloadBanner, shouldShowDownloadBanner } from '@/lib/download-banner-session'
import { isWebDesktopPlatform, isTauri } from '@/lib/platform'

const showAppDownloads = import.meta.env.VITE_SHOW_APP_DOWNLOADS === 'true'

export const DownloadAppBannerDesktop = () => {
  const [dismissed, setDismissed] = useState(false)

  if (!showAppDownloads || isTauri() || !isWebDesktopPlatform()) {
    return null
  }
  if (!shouldShowDownloadBanner()) {
    return null
  }

  const downloadUrl = getDownloadUrl()

  const handleDownload = () => {
    window.open(downloadUrl, '_blank', 'noopener,noreferrer')
    setDismissed(true)
    dismissDownloadBanner()
  }

  const handleDismiss = () => {
    setDismissed(true)
    dismissDownloadBanner()
  }

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          key="download-banner-desktop"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 right-4 z-50 max-w-sm"
        >
          <div className="bg-card border border-border rounded-lg shadow-lg p-4">
            <div className="flex flex-col gap-3">
              <Download className="size-5 text-foreground" />

              <div>
                <p className="text-sm font-semibold text-foreground">Get Thunderbolt free app</p>
                <p className="text-xs text-muted-foreground mt-0.5">One app, every AI model</p>
              </div>

              <div className="flex gap-2">
                <Button size="sm" onClick={handleDownload}>
                  Download App
                </Button>
                <Button size="sm" variant="outline" onClick={handleDismiss}>
                  Later
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
