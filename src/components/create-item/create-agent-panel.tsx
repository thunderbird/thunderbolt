/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CreateAgentPanel as AgentFormPanel } from '@/components/settings/agents/create-agent-panel'
import { CreateItemSurface } from './create-item-surface'

type CreateAgentPanelProps = {
  open: boolean
  onClose: () => void
}

/** Adds a custom agent over the current screen without changing routes. */
export const CreateAgentPanel = ({ open, onClose }: CreateAgentPanelProps) => (
  <CreateItemSurface open={open} onClose={onClose}>
    <AgentFormPanel onClose={onClose} />
  </CreateItemSurface>
)
