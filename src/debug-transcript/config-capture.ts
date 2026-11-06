/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectDebugTranscriptsEnabled, useConfigStore } from '@/api/config-store'

type SetCaptureEnabled = (enabled: boolean) => void

/** Seed transcript capture from hydrated config and keep it synchronized. */
export const registerDebugTranscriptCapture = (setCaptureEnabled: SetCaptureEnabled): (() => void) => {
  const syncCapture = () => {
    setCaptureEnabled(selectDebugTranscriptsEnabled(useConfigStore.getState().config))
  }
  const unsubscribe = useConfigStore.subscribe((state, previousState) => {
    if (state.config !== previousState.config) {
      syncCapture()
    }
  })
  syncCapture()
  return unsubscribe
}
