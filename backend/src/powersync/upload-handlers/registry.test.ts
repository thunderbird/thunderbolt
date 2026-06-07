/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { powersyncTableNames } from '@shared/powersync-tables'
import { describe, expect, it } from 'bun:test'
import { handlers } from './registry'

/**
 * Schema-drift test (addendum §3.9): the upload handler registry must cover every
 * synced table. The `Record<PowerSyncTableName, UploadHandler>` constraint already
 * catches this at compile time — this runtime assertion is a defensive check that
 * the registry never gets accidentally narrowed (e.g. via casts).
 */
describe('upload handler registry', () => {
  it('has a handler for every synced table', () => {
    const missing = powersyncTableNames.filter((name) => !(name in handlers))
    expect(missing).toEqual([])
  })

  it('does not expose handlers for unknown table names', () => {
    const extra = Object.keys(handlers).filter((name) => !powersyncTableNames.includes(name as never))
    expect(extra).toEqual([])
  })

  it('every handler exposes validate and apply functions', () => {
    for (const name of powersyncTableNames) {
      const handler = handlers[name]
      expect(typeof handler.validate).toBe('function')
      expect(typeof handler.apply).toBe('function')
    }
  })
})
