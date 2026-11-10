/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { i18n } from '@lingui/core'
import { invoke } from '@tauri-apps/api/core'
import { isTauriDesktop } from './platform'

export class TrayManager {
  /** Native code owns the tray across HMR and reloads; each initialization refreshes its labels. */
  static async initIfSupported(): Promise<void> {
    if (!isTauriDesktop()) {
      return
    }
    await invoke('initialize_tray', {
      showLabel: i18n._(msg`Show`),
      quitLabel: i18n._(msg`Quit`),
    })
  }
}
