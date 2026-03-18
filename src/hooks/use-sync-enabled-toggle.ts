import { hasMasterKey } from '@/crypto'
import { isSyncEnabled, setSyncEnabled, syncEnabledChangeEvent } from '@/db/powersync'
import { trackEvent } from '@/lib/posthog'
import { useEffect, useState } from 'react'

/**
 * Shared hook for sync toggle state and handlers used by PowerSyncStatus and
 * PreferencesSettingsPage. Manages syncEnabled state, the sync setup modal,
 * and event listener for external changes (e.g. sign-in flow).
 *
 * When the user enables sync and no encryption key exists, opens the Sync Setup
 * modal instead of enabling immediately. After key setup completes, the modal
 * calls handleConfirmEnableSync to actually enable sync.
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

  const handleSyncToggle = async (enabled: boolean) => {
    if (!enabled) {
      await setSyncEnabled(false)
      setSyncEnabledState(false)
      trackEvent('settings_sync_disabled')
      return
    }

    // If encryption key exists, the setup modal will complete immediately.
    // If not, the modal walks the user through key creation/import first.
    if (hasMasterKey()) {
      await setSyncEnabled(true)
      setSyncEnabledState(true)
      trackEvent('settings_sync_enabled')
    } else {
      setSyncSetupOpen(true)
    }
  }

  const handleConfirmEnableSync = async () => {
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
    handleConfirmEnableSync,
  }
}
