import { isSyncEnabled, setSyncEnabled, SYNC_ENABLED_CHANGE_EVENT } from '@/db/powersync'
import { trackEvent } from '@/lib/posthog'
import { useEffect, useState } from 'react'

/**
 * Shared hook for sync toggle state and handlers used by PowerSyncStatus and
 * PreferencesSettingsPage. Manages syncEnabled state, the enable-warning dialog,
 * and event listener for external changes (e.g. sign-in flow).
 */
export const useSyncEnabledToggle = () => {
  const [syncEnabled, setSyncEnabledState] = useState(isSyncEnabled())
  const [syncEnableWarningOpen, setSyncEnableWarningOpen] = useState(false)

  useEffect(() => {
    const handleSyncEnabledChange = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>
      setSyncEnabledState(customEvent.detail)
    }

    window.addEventListener(SYNC_ENABLED_CHANGE_EVENT, handleSyncEnabledChange)
    return () => window.removeEventListener(SYNC_ENABLED_CHANGE_EVENT, handleSyncEnabledChange)
  }, [])

  const handleSyncToggle = async (enabled: boolean) => {
    if (!enabled) {
      await setSyncEnabled(false)
      setSyncEnabledState(false)
      trackEvent('settings_sync_disabled')
      return
    }
    setSyncEnableWarningOpen(true)
  }

  const handleConfirmEnableSync = async () => {
    await setSyncEnabled(true)
    setSyncEnabledState(true)
    trackEvent('settings_sync_enabled')
    setSyncEnableWarningOpen(false)
  }

  return {
    syncEnabled,
    syncEnableWarningOpen,
    setSyncEnableWarningOpen,
    handleSyncToggle,
    handleConfirmEnableSync,
  }
}
