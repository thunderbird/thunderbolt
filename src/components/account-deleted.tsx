/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'

export const AccountDeleted = () => (
  <div className="flex flex-col items-center justify-center w-full h-dvh">
    <div className="flex flex-col items-center gap-8 text-center">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <AppLogo size={16} />
        <span>Thunderbolt</span>
      </div>

      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">Account Deleted</h1>
        <p className="text-muted-foreground">Your account has been deleted and local data has been cleared.</p>
      </div>

      <Button variant="secondary" onClick={() => window.location.replace('/')}>
        Back to App
      </Button>
    </div>
  </div>
)
