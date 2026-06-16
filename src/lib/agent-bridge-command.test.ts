/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { RegistryDistribution, RegistryEntry } from '@/types/registry'
import { composeBridgeCommand, composeInstallCommand, composeLaunchCommand } from './agent-bridge-command'

const entry = (distribution: RegistryDistribution): RegistryEntry => ({
  id: 'test-agent',
  name: 'Test Agent',
  version: '1.0.0',
  description: '',
  authors: [],
  license: '',
  distribution,
})

describe('composeLaunchCommand', () => {
  it('builds an npx launch command from package only', () => {
    expect(composeLaunchCommand(entry({ npx: { package: '@agentclientprotocol/claude-agent-acp' } }))).toBe(
      'npx @agentclientprotocol/claude-agent-acp',
    )
  })

  it('appends npx args after the package', () => {
    expect(composeLaunchCommand(entry({ npx: { package: 'some-agent', args: ['--flag', 'value'] } }))).toBe(
      'npx some-agent --flag value',
    )
  })

  it('builds a uvx launch command', () => {
    expect(composeLaunchCommand(entry({ uvx: { package: 'py-agent', args: ['serve'] } }))).toBe('uvx py-agent serve')
  })

  it('prefers npx over uvx when both are present', () => {
    expect(composeLaunchCommand(entry({ npx: { package: 'node-agent' }, uvx: { package: 'py-agent' } }))).toBe(
      'npx node-agent',
    )
  })

  it('returns null for a binary-only distribution', () => {
    expect(composeLaunchCommand(entry({ binary: { 'darwin-arm64': 'https://example.com/agent' } }))).toBeNull()
  })

  it('returns null for an empty distribution', () => {
    expect(composeLaunchCommand(entry({}))).toBeNull()
  })
})

describe('composeInstallCommand', () => {
  it('mirrors the launch command for npx', () => {
    expect(composeInstallCommand(entry({ npx: { package: 'node-agent' } }))).toBe('npx node-agent')
  })

  it('returns null for a binary-only distribution', () => {
    expect(composeInstallCommand(entry({ binary: {} }))).toBeNull()
  })
})

describe('composeBridgeCommand', () => {
  it('wraps the npx launch command in acp-bridge', () => {
    expect(composeBridgeCommand(entry({ npx: { package: '@agentclientprotocol/claude-agent-acp' } }))).toBe(
      'npx acp-bridge -- npx @agentclientprotocol/claude-agent-acp',
    )
  })

  it('wraps a uvx launch command with its args', () => {
    expect(composeBridgeCommand(entry({ uvx: { package: 'py-agent', args: ['serve', '--port', '0'] } }))).toBe(
      'npx acp-bridge -- uvx py-agent serve --port 0',
    )
  })

  it('returns null for a binary-only distribution', () => {
    expect(composeBridgeCommand(entry({ binary: { 'linux-x64': {} } }))).toBeNull()
  })
})
