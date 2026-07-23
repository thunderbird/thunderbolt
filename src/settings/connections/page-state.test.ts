/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { connectionsPageReducer, createConnectionsPageState } from './page-state'

describe('connectionsPageReducer', () => {
  it('clears form-scoped errors when changing modes', () => {
    const failed = {
      ...createConnectionsPageState(),
      importError: 'bad import',
      updateError: 'bad update',
    }
    expect(connectionsPageReducer(failed, { type: 'set-mode', mode: 'advanced' })).toMatchObject({
      mode: 'advanced',
      importError: null,
      updateError: null,
    })
  })

  it('uses a single selection for mutually exclusive panels', () => {
    const selected = connectionsPageReducer(createConnectionsPageState(), {
      type: 'select',
      selection: { kind: 'server', id: 'server-1' },
    })
    expect(selected.selected).toEqual({ kind: 'server', id: 'server-1' })
    expect(connectionsPageReducer(selected, { type: 'select', selection: null }).selected).toBeNull()
  })
})
