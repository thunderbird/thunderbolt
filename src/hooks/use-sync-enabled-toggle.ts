/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { needsSyncSetupWizard, waitForEncryptionInit } from '@/db/encryption'
import { isSyncEnabled, setSyncEnabled, syncEnabledChangeEvent } from '@/db/powersync/sync-state'
import { trackEvent } from '@/lib/posthog'
import { useEffect, useState } from 'react'

/**
 * Turn sync off for a device that has it on but no local key hierarchy — it
 * cannot encrypt, so syncing would be broken until the wizard runs. Returns
 * whether sync was disabled.
 *
 * A returning v1 device reports "setup incomplete" for the whole duration of its
 * seamless migration, which only stores the AK at its last step, so this waits
 * for the boot-time migration verdict before concluding anything. Exported for
 * unit tests — the decision is the interesting part, not the effect wrapping it.
 */
export const disableSyncIfSetupIncomplete = async (): Promise<boolean> => {
  // Fast path: a device that already holds a keyring needs no migration
  // verdict, so don't park it on the gate.
  if (!isSyncEnabled() || !(await needsSyncSetupWizard())) {
    return false
  }
  // A timed-out gate is not a verdict — a migration still running looks exactly
  // like a device that was never set up, and disabling sync there would strand
  // the migration seconds before it completes. Leave it alone; the next mount
  // re-checks.
  if (!(await waitForEncryptionInit())) {
    return false
  }
  if (!(await needsSyncSetupWizard())) {
    return false
  }
  // The user notices sync is off, toggles it on, and the normal wizard flow
  // handles the rest.
  await setSyncEnabled(false)
  return true
}

/**
 * Shared hook for sync toggle state and handlers used by SidebarFooter and
 * PreferencesSettingsPage. Manages syncEnabled state, the sync setup modal,
 * and event listener for external changes (e.g. sign-in flow).
 *
 * On mount, detects devices with sync ON but no local key hierarchy and
 * auto-disables sync. The user re-enables sync via the toggle, which opens the
 * wizard through the normal flow.
 */
export const useSyncEnabledToggle = () => {
  const [syncEnabled, setSyncEnabledState] = useState(isSyncEnabled())
  const [syncSetupOpen, setSyncSetupOpen] = useState(false)

  useEffect(() => {
    const handleSyncEnabledChange = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>
      setSyncEnabledState(customEvent.detail)
    }

    window.addEventListener(syncEnabledChangeEvent, handleSyncEnabledChange)
    return () => window.removeEventListener(syncEnabledChangeEvent, handleSyncEnabledChange)
  }, [])

  // Detect devices with sync ON but no local AK+DEK yet. No state update here:
  // `setSyncEnabled` dispatches `syncEnabledChangeEvent` synchronously, and the
  // listener registered above — always mounted first — already applies it.
  useEffect(() => {
    void disableSyncIfSetupIncomplete()
  }, [])

  const handleSyncToggle = async (enabled: boolean) => {
    if (!enabled) {
      await setSyncEnabled(false)
      setSyncEnabledState(false)
      trackEvent('settings_sync_disabled')
      return
    }
    if (await needsSyncSetupWizard()) {
      setSyncSetupOpen(true)
      return
    }
    await setSyncEnabled(true)
    setSyncEnabledState(true)
    trackEvent('settings_sync_enabled')
  }

  const handleSyncSetupComplete = async () => {
    await setSyncEnabled(true)
    setSyncEnabledState(true)
    trackEvent('settings_sync_enabled')
    setSyncSetupOpen(false)
  }

  return {
    syncEnabled,
    syncSetupOpen,
    setSyncSetupOpen,
    handleSyncToggle,
    handleSyncSetupComplete,
  }
}
