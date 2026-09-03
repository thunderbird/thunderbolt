/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useMiniAppStore } from './mini-app-store'
import { MiniAppApprovalPrompt } from './mini-app-approval-prompt'

/**
 * Renders the pending Mini App tool approval above the prompt input.
 *
 * The sibling of {@link PermissionDialogHost}, mounted in the same slot in
 * `ChatUI` and for the same reason: a decision the turn is blocked on belongs
 * where the user is already reading. In an ordinary chat there is no active app
 * and so nothing to render, which is why this can sit unconditionally in the
 * shared chat surface rather than only in the Mini App panel.
 *
 * The deadline lives in the store, not here — see `approvalTimeoutMs`. A prompt
 * that unmounts (the user navigates away mid-decision) must still resolve the
 * `execute` it is blocking, so the timer cannot belong to the component.
 */
export const MiniAppApprovalHost = () => {
  const activeApp = useMiniAppStore((state) => state.activeApp)
  const pendingApproval = useMiniAppStore((state) => state.pendingApproval)
  const resolveApproval = useMiniAppStore((state) => state.resolveApproval)

  if (!pendingApproval || !activeApp) {
    return null
  }

  return <MiniAppApprovalPrompt pending={pendingApproval} appName={activeApp.name} onDecide={resolveApproval} />
}
