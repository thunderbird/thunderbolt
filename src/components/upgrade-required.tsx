/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { useDesktopUpdate, type UpdateStatus } from '@/hooks/use-desktop-update'
import { isDesktop } from '@/lib/platform'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

type UpgradeRequiredProps = {
  currentVersion: string
  minVersion: string
}

/** Desktop button label per update status — mirrors the primary action of the
 *  `UpdateNotification` popover, extended to the states the popover hides.
 *  Descriptors, not strings: this table lives at module scope, so `t` would
 *  freeze the locale at import time (see docs in CLAUDE.md). */
const desktopActionLabel: Record<UpdateStatus, MessageDescriptor> = {
  initial: msg`Check for updates`,
  idle: msg`Check for updates`,
  checking: msg`Checking…`,
  available: msg`Download update`,
  downloading: msg`Downloading…`,
  ready: msg`Restart to update`,
  error: msg`Retry`,
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

  const busy = status === 'checking' || status === 'downloading'

  return (
    <Button variant="secondary" onClick={primaryAction} disabled={busy}>
      {i18n._(desktopActionLabel[status])}
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
        <h1 className="text-4xl font-semibold tracking-tight">
          <Trans>Update required</Trans>
        </h1>
        <p className="text-muted-foreground max-w-md">
          <Trans>
            This version of Thunderbolt is no longer supported. Update the app to keep chatting and syncing.
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
