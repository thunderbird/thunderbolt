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
    expect(buildRunCommand(entry({ npx: { package: '@augmentcode/auggie@0.29.0', args: ['--acp'] } }))).toBe(
      'npx -y @augmentcode/auggie@0.29.0 --acp',
    )
  })

  it('builds an npx command with no args', () => {
    expect(buildRunCommand(entry({ npx: { package: 'goose@1.2.3' } }))).toBe('npx -y goose@1.2.3')
  })

  it('builds a uvx command (no -y)', () => {
    expect(buildRunCommand(entry({ uvx: { package: 'fast-agent@2.0.0', args: ['acp'] } }))).toBe(
      'uvx fast-agent@2.0.0 acp',
    )
  })

  it('prefers npx over uvx and binary when several are present', () => {
    const distribution = {
      npx: { package: 'primary@1' },
      uvx: { package: 'secondary@1' },
      binary: { 'darwin-aarch64': { cmd: './fallback', args: ['acp'] } },
    }
    expect(buildRunCommand(entry(distribution))).toBe('npx -y primary@1')
  })

  it('returns null for binary-only distributions', () => {
    const binary = {
      'darwin-aarch64': { cmd: './vtcode', args: ['acp'] },
      'windows-x86_64': { cmd: 'vtcode.exe', args: ['acp'] },
    }
    expect(buildRunCommand(entry({ binary }))).toBeNull()
  })

  it('returns null when the entry ships no distribution', () => {
    expect(buildRunCommand(entry({}))).toBeNull()
  })
})
