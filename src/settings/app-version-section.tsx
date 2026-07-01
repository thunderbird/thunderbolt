/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { openUrl } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { useDesktopUpdate, type UpdateErrorPhase, type UpdateStatus } from '@/hooks/use-desktop-update'
import { downloadLinks } from '@/lib/download-links'
import { getPlatform, isDesktop, isMobile, isTauri } from '@/lib/platform'

const errorPrefix = (phase: UpdateErrorPhase | null): string => {
  switch (phase) {
    case 'download':
      return "Couldn't download the update"
    case 'restart':
      return "Couldn't restart to apply the update"
    case 'check':
    case null:
      return "Couldn't check for updates"
  }
}

const desktopStatusText = (
  status: UpdateStatus,
  updateVersion: string | undefined,
  downloadProgress: number,
  error: string | null,
  errorPhase: UpdateErrorPhase | null,
): string => {
  switch (status) {
    case 'initial':
      return 'Tap to check for updates.'
    case 'idle':
      return "You're on the latest version."
    case 'checking':
      return 'Checking for updates...'
    case 'available':
      return updateVersion
        ? `Version ${updateVersion} is available. See the update prompt to install.`
        : 'A new version is available. See the update prompt to install.'
    case 'downloading':
      return `Downloading update... ${downloadProgress}%`
    case 'ready':
      return 'Update ready. Restart to apply.'
    case 'error': {
      const prefix = errorPrefix(errorPhase)
      return error ? `${prefix}: ${error}` : `${prefix}.`
    }
  }
}

export const AppVersionSection = () => {
  const appVersion = import.meta.env.VITE_APP_VERSION ?? 'unknown'
  const desktop = isDesktop()
  const mobile = isMobile()
  const showCheckButton = isTauri() && (desktop || mobile)

  const { status, update, error, errorPhase, downloadProgress, checkForUpdates } = useDesktopUpdate()
  const checkDisabled = desktop && (status === 'checking' || status === 'downloading' || status === 'ready')

  const handleDesktopCheck = () => {
    checkForUpdates()
  }

  const handleMobileCheck = () => {
    const url = getPlatform() === 'ios' ? downloadLinks.ios : downloadLinks.android
    openUrl(url)
  }

  return (
    <SectionCard title="App Version">
      <div className="flex flex-col gap-6">
        <div className="flex flex-row items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">Current version</label>
            <p className="text-sm text-muted-foreground">{appVersion}</p>
          </div>
        </div>

        {showCheckButton && (
          <>
            <div className="h-px bg-border -mx-6" />

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Updates</label>
              <p className="text-sm text-muted-foreground">
                {desktop
                  ? desktopStatusText(status, update?.version, downloadProgress, error, errorPhase)
                  : 'Open the store to check for updates.'}
              </p>
              <Button
                variant="secondary"
                disabled={checkDisabled}
                onClick={desktop ? handleDesktopCheck : handleMobileCheck}
              >
                {desktop && status === 'checking' ? 'Checking...' : 'Check for updates'}
              </Button>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}
