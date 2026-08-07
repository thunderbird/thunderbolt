/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { navigationCommands } from './navigation'

describe('navigationCommands', () => {
  it('covers every sidebar + top-level route the palette should jump to', () => {
    const routes = navigationCommands.map((command) => command.to)
    expect(routes).toEqual([
      '/settings/agents',
      '/settings/skills',
      '/settings/connections',
      '/settings/models',
      '/settings/voice',
      '/settings/preferences',
      '/settings/devices',
      '/tasks',
      '/settings/dev-settings',
      '/message-simulator',
    ])
  })

  it('gates only the experimental/dev routes, leaving core routes ungated', () => {
    const gateFor = (to: string) => navigationCommands.find((command) => command.to === to)?.gate
    expect(gateFor('/settings/voice')).toBe('voice')
    expect(gateFor('/tasks')).toBe('tasks')
    expect(gateFor('/settings/dev-settings')).toBe('dev')
    expect(gateFor('/message-simulator')).toBe('dev')
    expect(gateFor('/settings/agents')).toBeUndefined()
    expect(gateFor('/settings/preferences')).toBeUndefined()
  })

  it('assigns a unique id and an icon to every command', () => {
    const ids = navigationCommands.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      navigationCommands.every((command) => typeof command.icon === 'function' || typeof command.icon === 'object'),
    ).toBe(true)
  })
})
