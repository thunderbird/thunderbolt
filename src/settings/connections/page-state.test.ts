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
    expect(connectionsPageReducer(failed, { type: 'MODE_CHANGED', mode: 'advanced' })).toMatchObject({
      mode: 'advanced',
      importError: null,
      updateError: null,
    })
  })

  it('scopes a failed server action to that server and clears it on retry/selection', () => {
    const failed = connectionsPageReducer(createConnectionsPageState(), {
      type: 'SERVER_FAILED',
      serverId: 'server-1',
      error: 'reconnect failed',
    })
    expect(failed.serverError).toEqual({ serverId: 'server-1', message: 'reconnect failed' })
    expect(connectionsPageReducer(failed, { type: 'RETRY_STARTED', serverId: 'server-1' }).serverError).toBeNull()
    expect(connectionsPageReducer(failed, { type: 'SELECTION_CHANGED', selection: null }).serverError).toBeNull()
  })

  it('keeps add failures on their own channel so the form title matches', () => {
    const failed = connectionsPageReducer(createConnectionsPageState(), {
      type: 'ADD_FAILED',
      error: 'add failed',
    })
    expect(failed.addError).toBe('add failed')
    expect(failed.updateError).toBeNull()
    expect(connectionsPageReducer(failed, { type: 'FORM_RESET' }).addError).toBeNull()
  })

  it('uses a single selection for mutually exclusive panels', () => {
    const selected = connectionsPageReducer(createConnectionsPageState(), {
      type: 'SELECTION_CHANGED',
      selection: { kind: 'server', id: 'server-1' },
    })
    expect(selected.selected).toEqual({ kind: 'server', id: 'server-1' })
    expect(connectionsPageReducer(selected, { type: 'SELECTION_CHANGED', selection: null }).selected).toBeNull()
  })
})
