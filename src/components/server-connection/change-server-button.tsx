/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { canChangeServer, disconnectUnclaimedServer } from '@/lib/server-connection'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

/** Correct a server choice before its first account sign-in without deleting local work. */
export const ChangeServerButton = () => {
  useLocalSettingsStore((state) => state.cloudUrl)
  useLocalSettingsStore((state) => state.serverHasAuthenticated)
  if (!canChangeServer()) {
    return null
  }
  return (
    <Button
      variant="outline"
      onClick={() => {
        disconnectUnclaimedServer()
        // Unload pending auth requests and queries before choosing another server.
        window.location.reload()
      }}
    >
      <Trans>Change server</Trans>
    </Button>
  )
}
