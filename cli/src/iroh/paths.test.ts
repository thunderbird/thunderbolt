/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The identity path is per-protocol: each bridge protocol resolves to a distinct
 * file (so the acp/mcp bridges get distinct NodeIds), and `acp` keeps the legacy
 * `identity` basename so existing pairings survive untouched.
 */

import { describe, expect, it } from 'bun:test'
import { basename } from 'node:path'
import { identityPath } from './paths.ts'

describe('identityPath', () => {
  it('resolves acp and mcp to distinct files', () => {
    expect(identityPath('acp')).not.toBe(identityPath('mcp'))
  })

  it('keeps the legacy `identity` basename for acp (pairing continuity)', () => {
    expect(basename(identityPath('acp'))).toBe('identity')
  })

  it('names the mcp identity `identity-mcp`', () => {
    expect(basename(identityPath('mcp'))).toBe('identity-mcp')
  })
})
