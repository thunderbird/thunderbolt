/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { useDesktopUpdate, type UpdateStatus } from '@/hooks/use-desktop-update'
import { isDesktop } from '@/lib/platform'

type UpgradeRequiredProps = {
  currentVersion: string
  minVersion: string
}

/** Desktop button label per update status — mirrors the primary action of the
 *  `UpdateNotification` popover, extended to the states the popover hides. */
const desktopActionLabel: Record<UpdateStatus, string> = {
  initial: 'Check for updates',
  idle: 'Check for updates',
  checking: 'Checking…',
  available: 'Download update',
  downloading: 'Downloading…',
  ready: 'Restart to update',
  error: 'Retry',
}

/**
 * The recovery action on the hard-block screen. On the web the only escape is a
 * reload (which re-fetches `/config`); on desktop we drive the same Tauri updater
 * flow as the `UpdateNotification` popover — check → download → restart.
 */
const UpgradeAction = () => {
  const { status, primaryAction } = useDesktopUpdate()

  if (!isDesktop()) {
    return (
      <Button variant="secondary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    )
  }

  const busy = status === 'checking' || status === 'downloading'

  return (
    <Button variant="secondary" onClick={primaryAction} disabled={busy}>
      {desktopActionLabel[status]}
    </Button>
  )
}

export const UpgradeRequired = ({ currentVersion, minVersion }: UpgradeRequiredProps) => (
  <div className="flex flex-col items-center justify-center w-full h-dvh">
    <div className="flex flex-col items-center gap-8 text-center">
      <div className="flex items-center gap-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
        <AppLogo size={16} />
        <span>Thunderbolt</span>
      </div>

      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">Update required</h1>
        <p className="text-muted-foreground max-w-md">
          This version of Thunderbolt is no longer supported. Update the app to keep chatting and syncing.
        </p>
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
          Installed: {currentVersion} · Minimum required: {minVersion}
        </p>
      </div>

      <UpgradeAction />
    </div>
  </div>
)
