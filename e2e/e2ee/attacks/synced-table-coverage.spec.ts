/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * THU-878 / THU-870 (reverse oracle) — every synced table must be covered by
 * `encryptedColumnsMap` (C1). **Claim: no synced table's user content may sync
 * unmapped, i.e. in plaintext.**
 *
 * The forward oracle (`expectEncryptedColumnsMapMatchesSchema`) and the plaintext
 * scans only ever look at MAPPED columns, so a whole synced table left out of the
 * map is invisible to all of them — which is exactly how the `agents` drift
 * (THU-870) shipped. `expectAllSyncedTablesMapped` closes that blind spot by
 * checking the coverage the other direction: schema → map.
 *
 * This is a pure static check over `powersyncTableNames` × `encryptedColumnsMap`
 * (no DB), so it doubles as a fast, permanent guard against a future table being
 * added to sync but forgotten in the map.
 *
 * THU-870 added `agents` to the map, this passed, and the `test.fail()` tag was
 * retired — so this is now the standing drift guard rather than an attack spec.
 * It must stay green: a new synced table with user-authored text and no map
 * entry fails here, which is the whole point.
 */

import { expect, test } from '../fixtures'
import { expectAllSyncedTablesMapped, findUnmappedSyncedTables } from '../oracles'

test('THU-878 — every synced table is covered by encryptedColumnsMap', () => {
  // Surfaces the offending table names in the report when this trips.
  expect(findUnmappedSyncedTables()).toEqual([])
  expectAllSyncedTablesMapped()
})
