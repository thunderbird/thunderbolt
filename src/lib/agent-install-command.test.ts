/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { RegistryEntry } from '@/types/registry'
import { buildRunCommand } from './agent-install-command'

const entry = (distribution: RegistryEntry['distribution']): RegistryEntry => ({
  id: 'test',
  name: 'Test',
  version: '1.0.0',
  description: '',
  authors: [],
  license: 'MIT',
  distribution,
})

describe('buildRunCommand', () => {
  it('builds an npx one-liner with -y and args', () => {
    expect(buildRunCommand(entry({ npx: { package: '@augmentcode/auggie@0.29.0', args: ['--acp'] } }), 'macos')).toBe(
      'npx -y @augmentcode/auggie@0.29.0 --acp',
    )
  })

  it('builds an npx command with no args', () => {
    expect(buildRunCommand(entry({ npx: { package: 'goose@1.2.3' } }), 'macos')).toBe('npx -y goose@1.2.3')
  })

  it('builds a uvx command (no -y)', () => {
    expect(buildRunCommand(entry({ uvx: { package: 'fast-agent@2.0.0', args: ['acp'] } }), 'linux')).toBe(
      'uvx fast-agent@2.0.0 acp',
    )
  })

  it('prefers npx over uvx and binary when several are present', () => {
    const distribution = {
      npx: { package: 'primary@1' },
      uvx: { package: 'secondary@1' },
      binary: { 'darwin-aarch64': { cmd: './fallback', args: ['acp'] } },
    }
    expect(buildRunCommand(entry(distribution), 'macos')).toBe('npx -y primary@1')
  })

  it('selects the platform-matching binary target', () => {
    const binary = {
      'darwin-aarch64': { cmd: './vtcode', args: ['acp'] },
      'windows-x86_64': { cmd: 'vtcode.exe', args: ['acp'] },
    }
    expect(buildRunCommand(entry({ binary }), 'windows')).toBe('vtcode.exe acp')
    expect(buildRunCommand(entry({ binary }), 'macos')).toBe('./vtcode acp')
  })

  it('falls back to the first binary target when the platform has no matching key', () => {
    const binary = {
      'darwin-aarch64': { cmd: './vtcode', args: ['acp'] },
      'linux-x86_64': { cmd: './vtcode', args: ['acp'] },
    }
    // Web/mobile have no per-platform binary — surface a representative command.
    expect(buildRunCommand(entry({ binary }), 'web')).toBe('./vtcode acp')
  })

  it('returns null when the entry ships no distribution', () => {
    expect(buildRunCommand(entry({}), 'macos')).toBeNull()
  })

  it('returns null when a binary target lacks a string cmd', () => {
    expect(buildRunCommand(entry({ binary: { 'darwin-aarch64': { archive: 'x.tar.gz' } } }), 'macos')).toBeNull()
  })

  it('returns null when the binary map is empty', () => {
    expect(buildRunCommand(entry({ binary: {} }), 'macos')).toBeNull()
  })
})
