/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Agent } from '@/types/acp'

/** Built-in and deployment-managed agents are read-only; custom agents belong to their creator. */
export const canManageAgent = (agent: Agent, userId: string | null) =>
  agent.type !== 'built-in' && agent.isSystem !== 1 && Boolean(userId) && agent.userId === userId
