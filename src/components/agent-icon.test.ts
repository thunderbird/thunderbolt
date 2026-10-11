/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { Globe, Server, Sparkles } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'
import { iconForAgent } from './agent-icon'

const hostedAgent: Agent = {
  ...builtInAgent,
  id: 'hosted-agent',
  type: 'managed-http',
  transport: 'http',
  url: '/v1/agent/chat',
}

describe('iconForAgent', () => {
  it('shows the icon a deployment names for its own agent', () => {
    expect(iconForAgent({ ...hostedAgent, icon: 'sparkles' })).toBe(Sparkles)
  })

  it('falls back to the server icon for a name outside the fixed set', () => {
    expect(iconForAgent({ ...hostedAgent, icon: 'skull' })).toBe(Server)
    expect(iconForAgent({ ...hostedAgent, icon: 'constructor' })).toBe(Server)
    expect(iconForAgent({ ...hostedAgent, icon: null })).toBe(Server)
  })

  it('ignores the icon field on a user-added agent and on the built-in', () => {
    expect(iconForAgent({ ...hostedAgent, type: 'remote-acp', isSystem: 0, icon: 'sparkles' })).toBe(Globe)
    expect(iconForAgent({ ...builtInAgent, icon: 'sparkles' })).toBe(AppLogo)
  })
})
