/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { deriveToolKey, findAllowOption, useChatStore, useCurrentChatSession } from '@/chats/chat-store'
import { PermissionDialog } from './permission-dialog'

/**
 * Renders the inline {@link PermissionDialog} for the current chat session's
 * `pendingPermission`. Mounted once near the prompt input; reads from the
 * store and resolves via `resolvePendingPermission`.
 */
export const PermissionDialogHost = () => {
  const { id, pendingPermission } = useCurrentChatSession()
  const allowAlwaysForAgent = useChatStore((state) => state.allowAlwaysForAgent)
  const allowAlwaysForTool = useChatStore((state) => state.allowAlwaysForTool)
  const resolvePendingPermission = useChatStore((state) => state.resolvePendingPermission)

  if (!pendingPermission) {
    return null
  }

  const allowOption = findAllowOption(pendingPermission.request.options)!
  const resolveAlwaysAllow = () => {
    resolvePendingPermission(id, { outcome: { outcome: 'selected', optionId: allowOption.optionId } })
  }
  const handleAlwaysAllowTool = () => {
    allowAlwaysForTool(pendingPermission.agentId, deriveToolKey(pendingPermission.request))
    resolveAlwaysAllow()
  }
  const handleAlwaysAllowAgent = () => {
    allowAlwaysForAgent(pendingPermission.agentId)
    resolveAlwaysAllow()
  }

  return (
    <PermissionDialog
      request={pendingPermission.request}
      onRespond={(response) => resolvePendingPermission(id, response)}
      onAlwaysAllowTool={handleAlwaysAllowTool}
      onAlwaysAllowAgent={handleAlwaysAllowAgent}
    />
  )
}
