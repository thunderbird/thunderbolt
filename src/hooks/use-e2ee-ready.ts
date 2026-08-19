/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { needsSyncSetupWizard } from '@/db/encryption'

/**
 * Whether E2EE v2 is fully operational on this device: the local key
 * hierarchy is complete (AK + at least one wrapped DEK). False for devices
 * that haven't yet migrated, followed, or run the setup wizard.
 */
export const isE2eeReady = async (): Promise<boolean> => !(await needsSyncSetupWizard())

/**
 * React hook flavor of `isE2eeReady` — resolves once on mount.
 * Key material only appears via the setup wizard or the seamless migration (a
 * full app flow), so a one-shot check is sufficient for settings surfaces.
 */
export const useE2eeReady = (): boolean => {
  const [ready, setReady] = useState(false)

  // Legitimate useEffect: async IndexedDB read on mount.
  useEffect(() => {
    let cancelled = false
    isE2eeReady().then((value) => {
      if (!cancelled) {
        setReady(value)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return ready
}
