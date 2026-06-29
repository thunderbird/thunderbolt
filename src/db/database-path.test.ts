/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getDbFilenameFor } from './database-path'

describe('getDbFilenameFor', () => {
  it('returns standalone.db for the standalone trust domain', () => {
    expect(getDbFilenameFor({ kind: 'standalone' })).toBe('standalone.db')
  })

  it('returns server-<serverId>.db for a server trust domain', () => {
    expect(getDbFilenameFor({ kind: 'server', serverId: 'abc-123' })).toBe('server-abc-123.db')
  })

  it('uses the full serverId verbatim (no truncation)', () => {
    const serverId = '11111111-2222-3333-4444-555555555555'
    expect(getDbFilenameFor({ kind: 'server', serverId })).toBe(`server-${serverId}.db`)
  })
})
