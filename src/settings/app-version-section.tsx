/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@/i18n'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { useDesktopUpdate, type UpdateErrorPhase, type UpdateStatus } from '@/hooks/use-desktop-update'
import { downloadLinks } from '@/lib/download-links'
import { getPlatform, isDesktop, isMobile, isTauri } from '@/lib/platform'

// A whole sentence per phase and per shape, rather than a translated prefix glued
// to the raw error with a hardcoded `: ` and `.`. The separator and the full stop
// are punctuation only a translator can place — French puts a space before the
// colon, Japanese ends on 。 — and neither is reachable from a fragment.
const errorText = (phase: UpdateErrorPhase | null, error: string | null): string => {
  switch (phase) {
    case 'download':
      return error ? i18n._(msg`Couldn't download the update: ${error}`) : i18n._(msg`Couldn't download the update.`)
    case 'restart':
      return error
        ? i18n._(msg`Couldn't restart to apply the update: ${error}`)
        : i18n._(msg`Couldn't restart to apply the update.`)
    case 'check':
    case null:
      return error ? i18n._(msg`Couldn't check for updates: ${error}`) : i18n._(msg`Couldn't check for updates.`)
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
      return i18n._(msg`Tap to check for updates.`)
    case 'idle':
      return i18n._(msg`You're on the latest version.`)
    case 'checking':
      return i18n._(msg`Checking for updates…`)
    case 'available':
      return updateVersion
        ? i18n._(msg`Version ${updateVersion} is available. See the update prompt to install.`)
        : i18n._(msg`A new version is available. See the update prompt to install.`)
    case 'downloading':
      return i18n._(msg`Downloading update… ${downloadProgress}%`)
    case 'ready':
      return i18n._(msg`Update ready. Restart to apply.`)
    case 'error':
      return errorText(errorPhase, error)
  }
}

export const AppVersionSection = () => {
  const { t } = useLingui()
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
    <SectionCard title={t`App Version`}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-row items-center justify-between gap-4">
          <div>
            <label className="text-sm font-medium">
              <Trans>Current version</Trans>
            </label>
            <p className="text-sm text-muted-foreground">{appVersion}</p>
          </div>
        </div>

        {showCheckButton && (
          <>
            <div className="h-px bg-border -mx-6" />

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">
                <Trans>Updates</Trans>
              </label>
              <p className="text-sm text-muted-foreground">
                {desktop
                  ? desktopStatusText(status, update?.version, downloadProgress, error, errorPhase)
                  : t`Open the store to check for updates.`}
              </p>
              <Button
                variant="secondary"
                disabled={checkDisabled}
                onClick={desktop ? handleDesktopCheck : handleMobileCheck}
              >
                {desktop && status === 'checking' ? <Trans>Checking…</Trans> : <Trans>Check for updates</Trans>}
              </Button>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}
