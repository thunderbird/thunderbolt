/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { expect, it } from 'bun:test'
import type { SearchSelection } from '@/stores/search-provider-store'
import { resolveSearchSelection } from './selection'

it.each([true, false])('honors an explicit connection without falling back to Cloud (available: %s)', (connection) => {
  expect(resolveSearchSelection('connection', { connection, cloud: true })).toBe(connection ? 'connection' : null)
})
it.each(['auto', 'cloud'] as const)('uses Cloud only when permitted for %s', (selection) => {
  expect(resolveSearchSelection(selection, { connection: true, cloud: true })).toBe('cloud')
  expect(resolveSearchSelection(selection, { connection: true, cloud: false })).toBeNull()
})
it('preserves an explicit opt-out even when both providers are available', () => {
  expect(resolveSearchSelection('none', { connection: true, cloud: true })).toBeNull()
})

it('does not interpret an unknown persisted selection as permission to use Cloud', () => {
  expect(resolveSearchSelection('unknown-provider' as SearchSelection, { connection: true, cloud: true })).toBeNull()
})
