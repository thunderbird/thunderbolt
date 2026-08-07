/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddAgentBody } from '@/components/agents/add-agent-body'
import { DetailPanelSurface } from '@/components/detail-panel'

type CreateAgentPanelProps = {
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
}

/** Adds an agent over the current screen without changing routes. Thin surface
 *  wrapper only — the panel body (`AddAgentBody`) is shared with the
 *  settings/agents route, so don't inline the form here. */
export const CreateAgentPanel = ({ open, onClose, onCloseComplete }: CreateAgentPanelProps) => (
  <DetailPanelSurface open={open} onClose={onClose} onCloseComplete={onCloseComplete} topInset>
    <AddAgentBody onClose={onClose} />
  </DetailPanelSurface>
)
