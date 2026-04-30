/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { X } from 'lucide-react'
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { getDownloadUrl } from '@/lib/download-links'
import { dismissDownloadBanner, shouldShowDownloadBanner } from '@/lib/download-banner-session'
import { isWebMobilePlatform, isTauri } from '@/lib/platform'

const showAppDownloads = import.meta.env.VITE_SHOW_APP_DOWNLOADS === 'true'

export const DownloadAppBannerMobile = () => {
  const [dismissed, setDismissed] = useState(false)

  if (!showAppDownloads || isTauri() || !isWebMobilePlatform()) {
    return null
  }
  if (!shouldShowDownloadBanner()) {
    return null
  }

  const storeUrl = getDownloadUrl()

  const handleDismiss = () => {
    setDismissed(true)
    dismissDownloadBanner()
  }

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          key="download-banner-mobile"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-0 left-0 right-0 z-50 bg-card border-b border-border shadow-sm"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              onClick={handleDismiss}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>

            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">One app, every AI model</p>
              <p className="text-xs text-muted-foreground truncate">Get Thunderbolt free app</p>
            </div>

            <Button
              size="sm"
              asChild
              className="flex-shrink-0"
              onClick={() => {
                setDismissed(true)
                dismissDownloadBanner()
              }}
            >
              <a href={storeUrl} target="_blank" rel="noopener noreferrer">
                Download
              </a>
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
