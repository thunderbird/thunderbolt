/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setCapturing, shouldCapture, usePostHogClient } from '@/lib/posthog'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useEffect } from 'react'
import { usePowerSyncStatus } from './use-powersync-status'
import { useSettings } from './use-settings'

/**
 * Keeps this device's PostHog capture following the synced `data_collection` setting while the app runs; `initPosthog`
 * sets where it starts. An opt-out made on another device takes effect here as soon as it syncs, and a device still
 * waiting on its first sync starts capturing only once that sync has confirmed the setting (see `shouldCapture`).
 * Synchronizing an external SDK is a legitimate effect.
 */
export const useAnalyticsConsent = () => {
  const posthog = usePostHogClient()
  const { dataCollection } = useSettings({ data_collection: false })
  const syncEnabled = useLocalSettingsStore((state) => state.syncEnabled)
  const { hasSynced } = usePowerSyncStatus()
  const isCapturing = shouldCapture({ dataCollection: dataCollection.value, syncEnabled, hasSynced })
  // While the setting loads its value is the fallback, which would briefly opt a capturing device out.
  const isLoaded = !dataCollection.isLoading

  useEffect(() => {
    if (posthog && isLoaded) {
      setCapturing(posthog, isCapturing)
    }
  }, [posthog, isLoaded, isCapturing])
}
