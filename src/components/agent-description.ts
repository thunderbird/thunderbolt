/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { builtInAgent, zeusAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

/** Resolve the same short agent description in selectors and settings at the active locale. */
export const getAgentDescription = (agent: Agent, i18n: I18n): string => {
  if (agent.type === 'built-in' && agent.id === builtInAgent.id) {
    return i18n._(msg`Confidential AI`)
  }
  if (agent.type === 'built-in' && agent.id === zeusAgent.id) {
    return i18n._(msg`Powerful frontier AI`)
  }
  return agent.description ?? ''
}
