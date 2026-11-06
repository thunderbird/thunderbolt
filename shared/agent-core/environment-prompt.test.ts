/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
// The bundle the app ships. A bare `just-bash` import resolves to the Node bundle,
// which carries commands (`sqlite3`, `xan`, `tar`) the browser bundle excludes.
import { Bash } from 'just-bash/browser'
import { appHarnessEnvironmentPrompt } from './environment-prompt.ts'

const advertisedCommands = (): string[] => {
  const line = appHarnessEnvironmentPrompt.split('\n').find((text) => text.startsWith('Available inside'))
  return line ? [...line.slice(line.indexOf(':')).matchAll(/`([^`]+)`/g)].map((match) => match[1]) : []
}

describe('appHarnessEnvironmentPrompt', () => {
  it('documents sandbox network constraints without assuming optional web tools exist', () => {
    expect(appHarnessEnvironmentPrompt).toContain('no network access')
    expect(appHarnessEnvironmentPrompt).toContain('`curl` and `wget` are unavailable')
    expect(appHarnessEnvironmentPrompt).toContain('when available')
  })

  it('names attachments as tab-separated workspace files', () => {
    expect(appHarnessEnvironmentPrompt).toContain('`attachments/`')
    expect(appHarnessEnvironmentPrompt).toContain("`awk -F'\\t'`")
  })

  it('advertises only commands the browser bundle can run', async () => {
    const bash = new Bash()
    const commands = advertisedCommands()
    expect(commands).toEqual(['grep', 'find', 'sed', 'awk', 'rg', 'jq'])
    for (const command of commands) {
      const result = await bash.exec(`${command} --help`)
      expect({ command, exitCode: result.exitCode }).not.toEqual({ command, exitCode: 127 })
    }
  })

  it('detects a command the browser bundle excludes', async () => {
    const bash = new Bash()
    expect((await bash.exec('sqlite3 --help')).exitCode).toBe(127)
  })
})
