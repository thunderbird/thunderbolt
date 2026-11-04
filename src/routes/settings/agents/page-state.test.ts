/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { agentActionPanel, agentConversationRedirect, agentPageState, agentPanelSearch } from './page-state'

it('opens agent settings by default and restores only the schedules subview', () => {
  expect(agentPageState(new URLSearchParams('agent=research'))).toEqual({
    panel: { kind: 'agent', id: 'research' },
    view: 'settings',
  })
  expect(agentPageState(new URLSearchParams('agent=research&view=schedules'))).toMatchObject({ view: 'schedules' })
  expect(agentPageState(new URLSearchParams('agent=research&conversation=chat&view=conversations'))).toEqual({
    panel: { kind: 'agent', id: 'research' },
    view: 'settings',
  })
  expect(agentPageState(new URLSearchParams('conversation=orphan'))).toEqual({ panel: null, view: 'settings' })
  expect(agentPanelSearch({ kind: 'agent', id: 'other' }).toString()).toBe('agent=other')
})

it('maps palette create and edit intents without a second navigation clearing the selected aside', () => {
  expect(agentActionPanel({ agentsAction: JSON.stringify({ type: 'create' }) })).toEqual({ kind: 'add' })
  expect(agentActionPanel({ agentsAction: JSON.stringify({ type: 'edit', id: 'cloud' }) })).toEqual({
    kind: 'agent',
    id: 'cloud',
  })
  expect(agentActionPanel({ agentsAction: '{bad data' })).toBeNull()
  expect(agentActionPanel(null)).toBeUndefined()
})

it('moves conversation bookmarks into normal chats while preserving the cloud agent identity', () => {
  expect(
    agentConversationRedirect(new URLSearchParams('agent=raw-agent&conversation=saved-id&view=conversations')),
  ).toBe('/chats/saved-id?cloudAgent=raw-agent')
  expect(agentConversationRedirect(new URLSearchParams('agent=raw-agent&view=schedules'))).toBeNull()
  expect(agentConversationRedirect(new URLSearchParams('conversation=orphan'))).toBeNull()
})
