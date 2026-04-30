/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './platform'

type SetAndroidBarColorDeps = {
  isTauri: () => boolean
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const defaultDeps: SetAndroidBarColorDeps = { isTauri, invoke }

/**
 * Sets the Android status bar and navigation bar icon appearance.
 * @param style - "dark" for dark icons (use on light backgrounds), "light" for light icons (use on dark backgrounds)
 */
export const setAndroidBarColor = async (
  style: 'dark' | 'light',
  deps: SetAndroidBarColorDeps = defaultDeps,
): Promise<void> => {
  if (!deps.isTauri()) {
    return
  }
  await deps.invoke('plugin:platform-utils|set_bar_color', { style })
}
