/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { buildCreateCommands } from './create-commands'
import type { PaletteCommand } from './types'

const byId = (commands: PaletteCommand[], id: string) => commands.find((command) => command.id === id)

const navOf = (command: PaletteCommand | undefined) => {
  if (!command || !('to' in command)) {
    throw new Error('expected a nav command carrying a `to`')
  }
  return command
}

describe('buildCreateCommands', () => {
  it('emits a create command per create-supporting entity, all in the create section', () => {
    const commands = buildCreateCommands()
    const ids = commands.map((command) => command.id)

    expect(ids).toEqual(['create-model', 'create-skill', 'create-agent'])
    expect(commands.every((command) => command.section === 'create')).toBe(true)
  })

  it('carries the settings-page `to` and a one-shot create intent in `state`', () => {
    const model = navOf(byId(buildCreateCommands(), 'create-model'))
    expect(model.to).toBe('/settings/models')
    expect(model.state).toEqual({ modelsAction: JSON.stringify({ type: 'create' }) })

    const skill = navOf(byId(buildCreateCommands(), 'create-skill'))
    expect(skill.to).toBe('/settings/skills')
    expect(skill.state).toEqual({ skillsAction: JSON.stringify({ type: 'create' }) })

    const agent = navOf(byId(buildCreateCommands(), 'create-agent'))
    expect(agent.to).toBe('/settings/agents')
    expect(agent.state).toEqual({ agentsAction: JSON.stringify({ type: 'create' }) })
  })

  it('titles each command "Create <Entity>"', () => {
    expect(byId(buildCreateCommands(), 'create-model')?.title).toBe('Create Model')
    expect(byId(buildCreateCommands(), 'create-skill')?.title).toBe('Create Skill')
    expect(byId(buildCreateCommands(), 'create-agent')?.title).toBe('Create Agent')
  })
})
