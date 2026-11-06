/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import { resolveSearchSelection } from './selection'

it('preserves existing key priority and automatically uses Tinfoil otherwise', () => {
  expect(resolveSearchSelection('auto', { custom: true, tinfoil: true, cloud: false })).toBe('custom')
  expect(resolveSearchSelection('auto', { custom: false, tinfoil: true, cloud: false })).toBe('tinfoil')
})
it('does not silently switch providers after an explicit choice or disable', () => {
  expect(resolveSearchSelection('none', { custom: true, tinfoil: true, cloud: true })).toBeNull()
  expect(resolveSearchSelection('tinfoil', { custom: true, tinfoil: false, cloud: true })).toBeNull()
  expect(resolveSearchSelection('tinfoil', { custom: true, tinfoil: true, cloud: false })).toBe('tinfoil')
})

it('does not fall from an unavailable configured Tinfoil connection to cloud', () => {
  const unavailable = { custom: false, tinfoil: false, tinfoilConfigured: true, cloud: true }
  expect(resolveSearchSelection('auto', unavailable)).toBeNull()
  expect(resolveSearchSelection('auto', { ...unavailable, tinfoil: true })).toBe('tinfoil')
  expect(resolveSearchSelection('auto', { ...unavailable, tinfoilConfigured: false })).toBe('cloud')
  expect(resolveSearchSelection('auto', { ...unavailable, custom: true })).toBe('custom')
  expect(resolveSearchSelection('cloud', unavailable)).toBe('cloud')
})
