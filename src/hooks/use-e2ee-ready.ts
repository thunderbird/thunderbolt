/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { needsSyncSetupWizard } from '@/db/encryption'

/**
 * Whether E2EE v2 is fully operational on this device: the local key hierarchy
 * is complete (AK + at least one wrapped DEK).
 * False for pre-encryption accounts and for devices that haven't yet migrated,
 * followed, or run the setup wizard.
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
    isE2eeReady()
      // A key store this device cannot read is not a ready one. Swallowing to
      // `false` rather than rejecting keeps an unavailable IndexedDB (blocked
      // storage, private browsing) from surfacing as an unhandled rejection in
      // whatever settings surface happens to mount this — the app already has a
      // dedicated screen for genuinely unusable storage.
      .catch(() => false)
      .then((value) => {
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
