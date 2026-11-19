/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { DeviceKeyTrust } from '@/components/recovery-continuity/recovery-continuity-status'
import { isAKUnverified } from '@/crypto'
import { needsSyncSetupWizard } from '@/db/encryption'

/**
 * Whether E2EE v2 is fully operational on this device: the local key hierarchy
 * is complete (AK + at least one wrapped DEK).
 * False for pre-encryption accounts and for devices that haven't yet migrated,
 * followed, or run the setup wizard.
 */
export const isE2eeReady = async (): Promise<boolean> => !(await needsSyncSetupWizard())

/**
 * Fired when app init has finished deciding this device's encryption state —
 * migrated, followed, already set up, or nothing to do. Init runs headlessly
 * and owns no render surface, so it announces the transition the same way the
 * post-migration phrase does (`useMigrationRecoveryKey`).
 */
export const e2eeProvisioningSettledEvent = 'e2ee_provisioning_settled'

/** Announce that provisioning settled, so mounted readiness probes re-read. */
export const dispatchE2eeProvisioningSettled = (): void => {
  window.dispatchEvent(new Event(e2eeProvisioningSettledEvent))
}

/**
 * React flavor of `isE2eeReady`.
 *
 * This used to resolve once on mount, on the reasoning that key material only
 * appears through a full app flow. That holds for the setup wizard, which owns
 * the screen — but NOT for the seamless v1→v2 migration, which runs
 * fire-and-forget from init (`runEncryptionInit`) while the app is already
 * usable. A settings page mounted in that window latched `false` forever:
 * `useLockoutPending` kept its query disabled, so a revoked device whose
 * rotation never landed was never offered "Finish securing", and the
 * change-phrase section stayed hidden — until the page happened to remount.
 *
 * So it re-checks whenever provisioning announces it settled, on top of the
 * read it already did on mount.
 *
 * Deliberately NOT `useQuery`, which the review that found this suggested: the
 * caching and error state it would add are unused (a cheap IndexedDB read, and
 * two consumers that both want a plain boolean), and react-query queries do not
 * settle under `renderHook` in this test harness — so that shape would ship
 * this regression's own fix with no test to hold it.
 */
export const useE2eeReady = (readReady: () => Promise<boolean> = isE2eeReady): boolean =>
  useProvisioningRead(readReady, false)

/** This device's key trust: whether it holds usable keys, and whether they were adopted unverified. */
export const readDeviceKeyTrust = async (): Promise<DeviceKeyTrust> => ({
  ready: await isE2eeReady(),
  unverified: await isAKUnverified(),
})

const untrusted: DeviceKeyTrust = { ready: false, unverified: false }

/**
 * React flavor of `readDeviceKeyTrust`, re-read like `useE2eeReady`. The guards
 * in the encryption service re-read the marker at action time; this only drives
 * what the UI offers.
 */
export const useDeviceKeyTrust = (read: () => Promise<DeviceKeyTrust> = readDeviceKeyTrust): DeviceKeyTrust =>
  useProvisioningRead(read, untrusted)

/** Read `read` on mount and whenever provisioning settles; `fallback` until then, and on failure. */
const useProvisioningRead = <T>(read: () => Promise<T>, fallback: T): T => {
  const [value, setValue] = useState(fallback)

  // Legitimate useEffect: an async read on mount plus a DOM event subscription,
  // both with cleanup.
  useEffect(() => {
    let generation = 0
    const check = async () => {
      const attempt = ++generation
      // A key store this device cannot read is not a ready one. Swallowing to
      // `false` rather than rejecting keeps an unavailable IndexedDB (blocked
      // storage, private browsing) from surfacing as an unhandled rejection in
      // whatever settings surface happens to mount this — the app already has a
      // dedicated screen for genuinely unusable storage.
      const next = await read().catch(() => fallback)
      if (attempt === generation) {
        setValue(next)
      }
    }
    void check()
    window.addEventListener(e2eeProvisioningSettledEvent, check)
    return () => {
      generation += 1
      window.removeEventListener(e2eeProvisioningSettledEvent, check)
    }
  }, [read, fallback])

  return value
}
