/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useSyncExternalStore } from 'react'
import { browserController } from './browser-controller'

/** Keep native browser automation visible and let the user stop queued input. */
export const BrowserAgentStatus = ({ tabId }: { tabId: string }) => {
  const state = useSyncExternalStore(browserController.subscribe, browserController.getState)
  if (!state.paused && state.busyTabId !== tabId) {
    return null
  }
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs"
      role="status"
    >
      <span>{state.paused ? <Trans>Browser control paused</Trans> : <Trans>Agent is using this tab</Trans>}</span>
      <button
        type="button"
        className="cursor-pointer rounded-xl px-2 py-1 font-medium hover:bg-muted"
        onClick={state.paused ? browserController.resume : browserController.stop}
      >
        {state.paused ? <Trans>Resume</Trans> : <Trans>Stop control</Trans>}
      </button>
    </div>
  )
}
