/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type UpgradeRequiredProps = {
  currentVersion: string
  minVersion: string
}

export const UpgradeRequired = ({ currentVersion, minVersion }: UpgradeRequiredProps) => (
  <div className="flex flex-col items-center justify-center w-full h-[100vh] p-4 text-center">
    <h1 className="text-[length:var(--font-size-body)] font-semibold mb-2">Update required</h1>
    <p className="text-[length:var(--font-size-sm)] text-muted-foreground max-w-md mb-4">
      This version of Thunderbolt is no longer supported. Update the app to keep chatting and syncing.
    </p>
    <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
      Installed: {currentVersion} · Minimum required: {minVersion}
    </p>
  </div>
)
