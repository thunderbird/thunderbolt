/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { RegistryDistribution, RegistryEntry } from '@/types/registry'
import { composeBridgeCommand, composeInstallCommand, composeLaunchCommand } from './agent-bridge-command'

const entryWith = (distribution: RegistryDistribution): RegistryEntry => ({
  id: 'test',
  name: 'Test Agent',
  version: '1.0.0',
  description: '',
  authors: [],
  license: 'MIT',
  distribution,
})

describe('composeLaunchCommand', () => {
  it('builds an npx launch with the package and args', () => {
    const entry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
    expect(composeLaunchCommand(entry)).toBe('npx @google/gemini-cli@0.46.0 --acp')
  })

  it('builds an npx launch with no args (package only)', () => {
    const entry = entryWith({ npx: { package: '@agentclientprotocol/claude-agent-acp@0.44.0' } })
    expect(composeLaunchCommand(entry)).toBe('npx @agentclientprotocol/claude-agent-acp@0.44.0')
  })

  it('builds a uvx launch when only uvx is present', () => {
    const entry = entryWith({ uvx: { package: 'fast-agent', args: ['acp'] } })
    expect(composeLaunchCommand(entry)).toBe('uvx fast-agent acp')
  })

  it('prefers npx over uvx when both are present', () => {
    const entry = entryWith({
      npx: { package: 'node-pkg' },
      uvx: { package: 'py-pkg' },
    })
    expect(composeLaunchCommand(entry)).toBe('npx node-pkg')
  })

  it('returns null for a binary-only distribution', () => {
    const entry = entryWith({ binary: { 'darwin-aarch64': { cmd: './goose', args: ['acp'] } } })
    expect(composeLaunchCommand(entry)).toBeNull()
  })

  it('returns null for an empty distribution', () => {
    expect(composeLaunchCommand(entryWith({}))).toBeNull()
  })
})

describe('composeBridgeCommand', () => {
  it('wraps an npx launch in the bridge command (--mode acp)', () => {
    const entry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
    expect(composeBridgeCommand(entry)).toBe(
      'npx thunderbolt-stdio-bridge --mode acp -- npx @google/gemini-cli@0.46.0 --acp',
    )
  })

  it('wraps a uvx launch in the bridge command', () => {
    const entry = entryWith({ uvx: { package: 'fast-agent', args: ['acp'] } })
    expect(composeBridgeCommand(entry)).toBe('npx thunderbolt-stdio-bridge --mode acp -- uvx fast-agent acp')
  })

  it('returns null for a binary-only distribution (UI points at the agent site/repo)', () => {
    const entry = entryWith({ binary: { 'linux-x86_64': { cmd: './goose' } } })
    expect(composeBridgeCommand(entry)).toBeNull()
  })
})

describe('composeInstallCommand', () => {
  it('returns the curl | bash one-liner for the bridge installer', () => {
    const command = composeInstallCommand()
    expect(command).toContain('curl -fsSL')
    expect(command).toContain('thunderbolt-stdio-bridge/install.sh')
    expect(command.endsWith('| bash')).toBe(true)
  })
})
