/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { create } from 'zustand'

type CloudExecutionNoticeStore = {
  isVisible: boolean
  dismiss: () => void
}

/** Visibility of the cloud-execution disclosure. Deliberately unpersisted: the
 *  "already seen" bit lives in local settings, this only drives the render. */
export const useCloudExecutionNoticeStore = create<CloudExecutionNoticeStore>()((set) => ({
  isVisible: false,
  dismiss: () => set({ isVisible: false }),
}))

/**
 * Disclose, once per device, that some runs are processed on Thunderbolt's
 * servers.
 *
 * Announced from the first send that actually reached the runner, never from
 * picking an agent: placement is decided per thread and can fall back to this
 * device, so disclosing any earlier would tell the user something that did not
 * happen. The seen flag is set here rather than on dismissal so a reload
 * mid-notice does not re-disclose.
 */
export const announceCloudExecution = (): void => {
  if (getLocalSetting('hasSeenCloudExecutionNotice')) {
    return
  }
  useLocalSettingsStore.getState().setLocalSetting('hasSeenCloudExecutionNotice', true)
  useCloudExecutionNoticeStore.setState({ isVisible: true })
}
