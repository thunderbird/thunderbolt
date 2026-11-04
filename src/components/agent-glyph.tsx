/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { iconForAgent } from '@/components/agent-icon'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types/acp'

/** Render a saved agent emoji, falling back to the agent type's standard icon. */
export const AgentGlyph = ({ agent, className }: { agent: Agent; className?: string }) => {
  if (agent.type === 'cloud' && agent.icon && agent.icon !== 'cloud') {
    return (
      <span
        aria-hidden="true"
        className={cn('inline-flex shrink-0 items-center justify-center leading-none', className)}
      >
        {agent.icon}
      </span>
    )
  }
  const Icon = iconForAgent(agent)
  return <Icon aria-hidden="true" className={className} />
}
