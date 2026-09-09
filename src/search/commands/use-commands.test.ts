/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { i18n } from '@/i18n'
import type { Theme } from '@/lib/theme-provider'
import { buildCommands, type BuildCommandsDeps } from './use-commands'
import type { PaletteCommand } from './types'

const makeDeps = (overrides: Partial<BuildCommandsDeps> = {}): BuildCommandsDeps => ({
  i18n,
  flags: { voice: false, tasks: false, dev: false },
  showDownloadApp: false,
  isMac: true,
  onNewChat: () => {},
  onSetTheme: () => {},
  onToggleSidebar: () => {},
  onSignOut: () => {},
  onClearAllChats: () => {},
  ...overrides,
})

const byId = (commands: PaletteCommand[], id: string) => commands.find((command) => command.id === id)

const runOf = (command: PaletteCommand | undefined) => {
  if (!command || !('run' in command)) {
    throw new Error('expected an action command with a run handler')
  }
  return command.run
}

describe('buildCommands — navigation gating', () => {
  it('hides voice/tasks/dev nav commands when their flags are off', () => {
    const ids = buildCommands(makeDeps()).map((command) => command.id)
    expect(ids).not.toContain('voice')
    expect(ids).not.toContain('tasks')
    expect(ids).not.toContain('dev-settings')
    expect(ids).not.toContain('message-simulator')
    // Ungated core routes are always present.
    expect(ids).toContain('agents')
    expect(ids).toContain('preferences')
  })

  it('reveals each gated nav command only when its own flag is on', () => {
    const voiceOnly = buildCommands(makeDeps({ flags: { voice: true, tasks: false, dev: false } })).map((c) => c.id)
    expect(voiceOnly).toContain('voice')
    expect(voiceOnly).not.toContain('tasks')
    expect(voiceOnly).not.toContain('dev-settings')

    const tasksOnly = buildCommands(makeDeps({ flags: { voice: false, tasks: true, dev: false } })).map((c) => c.id)
    expect(tasksOnly).toContain('tasks')
    expect(tasksOnly).not.toContain('voice')

    const devOnly = buildCommands(makeDeps({ flags: { voice: false, tasks: false, dev: true } })).map((c) => c.id)
    expect(devOnly).toContain('dev-settings')
    expect(devOnly).toContain('message-simulator')
    expect(devOnly).not.toContain('voice')
  })
})

describe('buildCommands — action wiring', () => {
  it('routes sign-out and clear-all-chats to the injected callbacks', () => {
    const onSignOut = mock(() => {})
    const onClearAllChats = mock(() => {})
    const commands = buildCommands(makeDeps({ onSignOut, onClearAllChats }))

    runOf(byId(commands, 'sign-out'))()
    runOf(byId(commands, 'clear-all-chats'))()

    expect(onSignOut).toHaveBeenCalledTimes(1)
    expect(onClearAllChats).toHaveBeenCalledTimes(1)
  })

  it('routes new chat and each theme command to the injected handlers', () => {
    const onNewChat = mock(() => {})
    const onSetTheme = mock((_theme: Theme) => {})
    const commands = buildCommands(makeDeps({ onNewChat, onSetTheme }))

    runOf(byId(commands, 'new-chat'))()
    expect(onNewChat).toHaveBeenCalledTimes(1)

    runOf(byId(commands, 'theme-light'))()
    runOf(byId(commands, 'theme-dark'))()
    runOf(byId(commands, 'theme-system'))()
    expect(onSetTheme.mock.calls).toEqual([['light'], ['dark'], ['system']])
  })

  it('includes the download command only behind its gate', () => {
    expect(byId(buildCommands(makeDeps({ showDownloadApp: false })), 'download-app')).toBeUndefined()
    expect(byId(buildCommands(makeDeps({ showDownloadApp: true })), 'download-app')).toBeDefined()
  })

  it('shows a platform-aware toggle-sidebar shortcut hint', () => {
    expect(byId(buildCommands(makeDeps({ isMac: true })), 'toggle-sidebar')?.shortcut).toBe('⌘B')
    expect(byId(buildCommands(makeDeps({ isMac: false })), 'toggle-sidebar')?.shortcut).toBe('Ctrl+B')
  })
})
