/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { needsSyncSetupWizard } from '@/db/encryption'
import { isSyncEnabled, setSyncEnabled } from '@/db/powersync/sync-state'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { trackEvent } from '@/lib/posthog'
import { useEffect, useRef, useState } from 'react'

/**
 * Shared hook for sync toggle state and handlers used by SidebarFooter and
 * PreferencesSettingsPage. Manages syncEnabled state, the sync setup modal,
 * and store subscription for external changes (e.g. sign-in flow).
 *
 * On mount, detects pre-encryption users (sync ON + encryption enabled + no CK)
 * and auto-disables sync. The user re-enables sync via the toggle, which opens
 * the wizard through the normal flow.
 */
export const useSyncEnabledToggle = () => {
  const syncEnabled = useLocalSettingsStore((state) => state.syncEnabled)
  const [syncSetupOpen, setSyncSetupOpen] = useState(false)
  const intent = useRef(0)

  // Detect pre-encryption users: sync ON + encryption enabled + no CK in IndexedDB
  useEffect(() => {
    let cancelled = false
    const initialIntent = intent.current
    const checkEncryptionMigration = async () => {
      if (!isSyncEnabled()) {
        return
      }
      if (!(await needsSyncSetupWizard())) {
        return
      }
      if (cancelled || intent.current !== initialIntent) {
        return
      }
      // Pre-encryption user: disable sync silently.
      // User will notice sync is off, toggle it on, and the normal wizard flow handles the rest.
      await setSyncEnabled(false)
    }
    void checkEncryptionMigration()
    return () => {
      cancelled = true
      intent.current += 1
    }
  }, [])

  const handleSyncToggle = async (enabled: boolean) => {
    const currentIntent = ++intent.current
    if (!enabled) {
      await setSyncEnabled(false)
      trackEvent('settings_sync_disabled')
      return
    }
    const needsSetup = await needsSyncSetupWizard()
    if (currentIntent !== intent.current) {
      return
    }
    if (needsSetup) {
      setSyncSetupOpen(true)
      return
    }
    await setSyncEnabled(true)
    trackEvent('settings_sync_enabled')
  }

  const handleSyncSetupComplete = async () => {
    intent.current += 1
    await setSyncEnabled(true)
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
