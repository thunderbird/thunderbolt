/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppWordmark } from '@/components/app-wordmark'
import { useAppName } from '@/lib/branding-selectors'
import { Button } from '@/components/ui/button'
import { desktopUpdateActionLabel, useDesktopUpdate } from '@/hooks/use-desktop-update'
import { isDesktop } from '@/lib/platform'
import { Trans, useLingui } from '@lingui/react/macro'

type UpgradeRequiredProps = {
  currentVersion: string
  minVersion: string
}

/**
 * The recovery action on the hard-block screen. On the web the only escape is a
 * reload (which re-fetches `/config`); on desktop we drive the same Tauri updater
 * flow as the `UpdateNotification` popover — check → download → restart.
 */
const UpgradeAction = () => {
  const { status, primaryAction } = useDesktopUpdate()
  const { i18n } = useLingui()

  if (!isDesktop()) {
    return (
      <Button variant="secondary" onClick={() => window.location.reload()}>
        <Trans>Reload</Trans>
      </Button>
    )
  }

  const busy = status === 'checking' || status === 'downloading' || status === 'restarting'

  return (
    <Button variant="secondary" onClick={primaryAction} disabled={busy}>
      {i18n._(desktopUpdateActionLabel[status])}
    </Button>
  )
}

export const UpgradeRequired = ({ currentVersion, minVersion }: UpgradeRequiredProps) => {
  const appName = useAppName()

  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh">
      <div className="flex flex-col items-center gap-8 text-center">
        <AppWordmark className="text-[length:var(--font-size-sm)]" />

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">
            <Trans>Update required</Trans>
          </h1>
          <p className="text-muted-foreground max-w-md">
            <Trans>
              This version of {appName} is no longer supported. Update the app to keep chatting and syncing.
            </Trans>
          </p>
          <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
            <Trans>
              Installed: {currentVersion} · Minimum required: {minVersion}
            </Trans>
          </p>
        </div>

        <UpgradeAction />
      </div>
    </div>
  )
}
