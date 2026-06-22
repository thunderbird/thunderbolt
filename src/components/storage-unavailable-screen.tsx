/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { isIosPlatform } from '@/lib/platform'

export const StorageUnavailableScreen = () => {
  const lockdownHint = isIosPlatform()
  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh p-4">
      <div className="flex flex-col items-center gap-8 text-center max-w-md">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <AppLogo size={16} />
          <span>Thunderbolt</span>
        </div>

        <div className="flex flex-col items-center gap-2">
          <h1 className="text-4xl font-semibold tracking-tight">Storage is disabled</h1>
          <p className="text-muted-foreground">
            Thunderbolt needs browser storage (IndexedDB) to work, but it's currently disabled.{' '}
            {lockdownHint
              ? 'If you are using iOS Lockdown Mode, exclude Thunderbolt from the "Configure Web Browsing" setting, then reopen the app.'
              : 'This can happen in private windows or when site data is blocked. Enable storage for this site and reload.'}
          </p>
        </div>

        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  )
}
