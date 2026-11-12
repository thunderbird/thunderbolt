/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { isTauriDesktop } from '@/lib/platform'
import { browserController } from '@/browser/browser-controller'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { localAppController } from '@/local-apps/local-app-controller'
import { useLocalAppStore } from '@/local-apps/local-app-store'
import { usePageStore } from './page-store'
import { localSavedPagesStore } from './local-saved-pages'
import { localSavedPageKeyPrefix } from './saved-page'

/** Close documents and subprocesses before another identity can use this app instance. */
export const clearPageIdentity = async (clearDeviceBindings: boolean) => {
  browserController.stop()
  usePageStore.setState({ sessions: [], activeId: null })
  const apps = Object.values(useLocalAppStore.getState().apps).filter((app) => !app.deletedAt)
  const stopped = await Promise.allSettled(apps.map((app) => localAppController.stop(app.id)))
  const failures: unknown[] = stopped.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (clearDeviceBindings && isTauriDesktop()) {
    try {
      await invoke('browser_clear_profile')
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    // Keep recipes and grants available for retry; strict account switching must
    // not continue while an old preview process or browser profile survives.
    throw new AggregateError(failures, 'Could not finish page identity cleanup')
  }
  if (clearDeviceBindings) {
    useLocalAppStore.setState({ apps: {} })
    useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(localSavedPageKeyPrefix)) {
        localStorage.removeItem(key)
      }
    }
    localSavedPagesStore.refresh()
  }
  browserController.resume()
}
