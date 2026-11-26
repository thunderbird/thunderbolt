/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { AppLayoutSkeleton } from '@/components/app-layout-skeleton'
import { Button } from '@/components/ui/button'
import Loading from '@/loading'

type LocalDataSwitchScreenProps = {
  hasFailed: boolean
  /** The session request failed without the server saying who is signed in, so the app waits for the network. */
  isWaitingForNetwork: boolean
  onSignOut: () => void
}

/**
 * Shown instead of the app until the open slot is `ready`: a loading screen while the session binds
 * or the device switches accounts, the same screen with a message while the app waits for the network,
 * and a way out if the switch fails.
 */
export const LocalDataSwitchScreen = ({ hasFailed, isWaitingForNetwork, onSignOut }: LocalDataSwitchScreenProps) => {
  if (!hasFailed) {
    // The status region is there from the first frame, because screen readers only announce text added to an existing one.
    return (
      <div className="relative isolate w-full">
        {isWaitingForNetwork && <AppLayoutSkeleton />}
        <div role="status">
          <Loading className="motion-reduce:animate-pulse" />
          {isWaitingForNetwork && (
            <p className="absolute inset-x-0 top-[calc(50vh+1.5rem)] px-6 text-center text-[length:var(--font-size-body)] text-balance text-muted-foreground">
              <Trans>Waiting for a spark… Thunderbolt opens on its own.</Trans>
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center w-full h-dvh p-4">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">
          <Trans>Couldn't switch accounts</Trans>
        </h1>
        <p className="text-muted-foreground">
          <Trans>The previous account's data on this device could not be secured. Reload to try again.</Trans>
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            <Trans>Reload</Trans>
          </Button>
          <Button variant="ghost" onClick={onSignOut}>
            <Trans>Sign out</Trans>
          </Button>
        </div>
      </div>
    </div>
  )
}
