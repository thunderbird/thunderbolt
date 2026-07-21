/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Globe, Server } from 'lucide-react'
import type { ComponentType } from 'react'

import { AppLogo } from '@/components/app-logo'
import type { Agent } from '@/types/acp'

/** Visual icon for each agent flavor: built-in (app logo), system/managed
 *  (server), remote (globe). Shared by the Settings agent list and the chat
 *  header selector so the two stay perceptually consistent. */
export const iconForAgent = (agent: Agent): ComponentType<{ className?: string }> => {
  if (agent.type === 'built-in') {
    return AppLogo
  }
  if (agent.type === 'managed-acp') {
    return Server
  }
  return Globe
}
