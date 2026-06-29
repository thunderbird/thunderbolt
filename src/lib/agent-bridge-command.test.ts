/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { RegistryDistribution, RegistryEntry } from '@/types/registry'
import {
  composeBridgeCommand,
  composeInstallCommand,
  composeLaunchCommand,
  composeMcpBridgeCommand,
} from './agent-bridge-command'

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
  it('wraps an npx launch in the bridge command (--mode acp), invoking the bare on-PATH binary', () => {
    const entry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
    const command = composeBridgeCommand(entry)
    expect(command).toBe('thunderbolt bridge --mode acp -- npx @google/gemini-cli@0.46.0 --acp')
    expect(command?.startsWith('thunderbolt bridge ')).toBe(true)
    expect(command?.startsWith('npx')).toBe(false)
  })

  it('wraps a uvx launch in the bridge command', () => {
    const entry = entryWith({ uvx: { package: 'fast-agent', args: ['acp'] } })
    expect(composeBridgeCommand(entry)).toBe('thunderbolt bridge --mode acp -- uvx fast-agent acp')
  })

  it('adds --allow-origin for a non-loopback app origin (production web)', () => {
    const entry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
    expect(composeBridgeCommand(entry, 'https://app.thunderbird.net')).toBe(
      "thunderbolt bridge --mode acp --allow-origin 'https://app.thunderbird.net' -- npx @google/gemini-cli@0.46.0 --acp",
    )
  })

  it('omits --allow-origin for a loopback app origin (default allowlist already accepts it)', () => {
    const entry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
    const command = composeBridgeCommand(entry, 'http://localhost:1421')
    expect(command).toBe('thunderbolt bridge --mode acp -- npx @google/gemini-cli@0.46.0 --acp')
    expect(command).not.toContain('--allow-origin')
  })

  it('omits --allow-origin when no origin is provided', () => {
    const entry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
    expect(composeBridgeCommand(entry)).not.toContain('--allow-origin')
  })

  it('returns null for a binary-only distribution (UI points at the agent site/repo)', () => {
    const entry = entryWith({ binary: { 'linux-x86_64': { cmd: './goose' } } })
    expect(composeBridgeCommand(entry)).toBeNull()
    expect(composeBridgeCommand(entry, 'https://app.thunderbird.net')).toBeNull()
  })
})

describe('composeMcpBridgeCommand', () => {
  it('wraps a stdio command in the bridge command (--mode mcp)', () => {
    const command = composeMcpBridgeCommand('npx @modelcontextprotocol/server-everything stdio')
    expect(command).toBe('thunderbolt bridge --mode mcp -- npx @modelcontextprotocol/server-everything stdio')
    expect(command?.startsWith('thunderbolt bridge --mode mcp')).toBe(true)
  })

  it('trims surrounding whitespace from the command', () => {
    expect(composeMcpBridgeCommand('  uvx mcp-server  ')).toBe('thunderbolt bridge --mode mcp -- uvx mcp-server')
  })

  it('returns null for a blank command', () => {
    expect(composeMcpBridgeCommand('')).toBeNull()
    expect(composeMcpBridgeCommand('   ')).toBeNull()
  })

  it('adds --allow-origin for a non-loopback app origin (production web)', () => {
    expect(composeMcpBridgeCommand('npx srv', 'https://app.thunderbird.net')).toBe(
      "thunderbolt bridge --mode mcp --allow-origin 'https://app.thunderbird.net' -- npx srv",
    )
  })

  it('omits --allow-origin for a loopback app origin', () => {
    expect(composeMcpBridgeCommand('npx srv', 'http://localhost:1421')).not.toContain('--allow-origin')
  })
})

describe('composeInstallCommand', () => {
  it('wraps the curl | bash installer in bash -c set -o pipefail so a failed curl fails the pipeline', () => {
    // Pin the exact string: a chopped closing quote would break the pasted command, and the
    // bash -c 'set -o pipefail; …' wrapper is the contract that propagates a failed curl.
    expect(composeInstallCommand()).toBe(
      "bash -c 'set -o pipefail; curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/cli/install.sh | bash'",
    )
  })
})
